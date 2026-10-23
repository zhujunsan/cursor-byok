//! Implements Cursor analytics endpoints and event handling.
use axum::{
    body::{Body, Bytes},
    extract::Extension,
    http::{header, HeaderValue, Request, Response, StatusCode},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::{BufMut, BytesMut};
use prost::Message;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::{api::cursor::proxy, Error, Result};

pub const BOOTSTRAP_STATSIG_PATH: &str = "/aiserver.v1.AnalyticsService/BootstrapStatsig";
const AGENT_RETRIES_GATE: &str = "nal_agent_retries";
// This backend owns the Agent loop and accepts agent.v1.AgentClientMessage.
// Cursor's local loop instead sends aiserver.v1.RunInferenceClientMessage over
// the same BidiAppend endpoint. Keep the client on our supported wire contract.
const LOCAL_AGENT_LOOP_GATE: &str = "agent_host_local_loop";

#[derive(Clone, PartialEq, Message)]
struct BootstrapStatsigResponse {
    #[prost(string, tag = "1")]
    config: String,
    #[prost(uint64, tag = "2")]
    generated_at_ms: u64,
}

pub async fn bootstrap_statsig(
    Extension(upstream): Extension<proxy::CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    match proxy::forward_buffered(&upstream, request).await {
        Ok(response) if response.status.is_success() => match patch_upstream(response) {
            Ok(response) => Ok(response),
            Err(error) => {
                tracing::warn!(%error, "Cursor Statsig bootstrap was invalid; using local bootstrap");
                local_response()
            }
        },
        Ok(response) => {
            tracing::warn!(status = %response.status, "Cursor Statsig bootstrap was rejected; using local bootstrap");
            local_response()
        }
        Err(error) => {
            tracing::warn!(%error, "Cursor Statsig bootstrap was unavailable; using local bootstrap");
            local_response()
        }
    }
}

fn patch_upstream(response: proxy::BufferedResponse) -> Result<Response<Body>> {
    let (framed, payload) = unary_payload(&response.body)?;
    let mut message = BootstrapStatsigResponse::decode(payload)?;
    let mut config = serde_json::from_str::<Value>(&message.config)?;
    configure_agent_runtime(&mut config)?;
    message.config = serde_json::to_string(&config)?;
    Ok(response.with_body(encode_unary(&message, framed)))
}

fn local_response() -> Result<Response<Body>> {
    let generated_at_ms = chrono::Utc::now().timestamp_millis() as u64;
    let mut config = json!({
        "feature_gates": {},
        "dynamic_configs": {},
        "layer_configs": {},
        "user": {
            "userID": "local_ultra",
            "customIDs": { "localUserID": "local_ultra" }
        },
        "has_updates": true,
        "hash_used": "none",
        "sdkParams": {
            "stableID": "local_ultra",
            "disableDiagnosticsLogging": true
        },
        "time": generated_at_ms
    });
    configure_agent_runtime(&mut config)?;
    let message = BootstrapStatsigResponse {
        config: serde_json::to_string(&config)?,
        generated_at_ms,
    };
    let body = message.encode_to_vec();
    let mut response = Response::new(Body::from(body.clone()));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/proto"),
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        body.len()
            .to_string()
            .parse()
            .expect("body length is a valid header value"),
    );
    Ok(response)
}

fn configure_agent_runtime(config: &mut Value) -> Result<()> {
    let retries_key = statsig_key(config, AGENT_RETRIES_GATE);
    let local_loop_key = statsig_key(config, LOCAL_AGENT_LOOP_GATE);
    let root = config
        .as_object_mut()
        .ok_or_else(|| Error::Protocol("Statsig bootstrap config must be an object".into()))?;
    let gates = root
        .entry("feature_gates")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| Error::Protocol("Statsig feature_gates must be an object".into()))?;
    gates.insert(retries_key.clone(), local_gate(&retries_key, true));
    gates.insert(local_loop_key.clone(), local_gate(&local_loop_key, false));
    Ok(())
}

fn statsig_key(config: &Value, name: &str) -> String {
    match config.get("hash_used").and_then(Value::as_str) {
        Some("djb2") => djb2(name),
        Some("sha256") => STANDARD.encode(Sha256::digest(name.as_bytes())),
        _ => name.to_owned(),
    }
}

fn djb2(value: &str) -> String {
    value
        .encode_utf16()
        .fold(0_u32, |hash, character| {
            hash.wrapping_mul(31).wrapping_add(u32::from(character))
        })
        .to_string()
}

fn local_gate(name: &str, enabled: bool) -> Value {
    let rule = if enabled {
        "local_enabled"
    } else {
        "local_disabled"
    };
    json!({
        "name": name,
        "value": enabled,
        "rule_id": rule,
        "ruleID": rule,
        "group_name": rule,
        "groupName": rule,
        "secondary_exposures": [],
        "secondaryExposures": [],
        "undelegated_secondary_exposures": [],
        "undelegatedSecondaryExposures": [],
        "is_device_based": false,
        "isDeviceBased": false,
        "id_type": "userID",
        "idType": "userID"
    })
}

fn unary_payload(body: &Bytes) -> Result<(bool, &[u8])> {
    if body.len() < 5 {
        return Ok((false, body));
    }
    let flags = body[0];
    let length = u32::from_be_bytes([body[1], body[2], body[3], body[4]]) as usize;
    if length != body.len() - 5 {
        return Ok((false, body));
    }
    if flags != 0 {
        return Err(Error::Protocol(format!(
            "cannot patch compressed or terminal Statsig frame: flags={flags}"
        )));
    }
    Ok((true, &body[5..]))
}

fn encode_unary(message: &impl Message, framed: bool) -> Bytes {
    let payload = message.encode_to_vec();
    if !framed {
        return Bytes::from(payload);
    }
    let mut output = BytesMut::with_capacity(5 + payload.len());
    output.put_u8(0);
    output.put_u32(payload.len() as u32);
    output.extend_from_slice(&payload);
    output.freeze()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    fn assert_backend_agent_loop(config: &Value) {
        let gates = config["feature_gates"].as_object().unwrap();
        assert_eq!(
            gates[&statsig_key(config, AGENT_RETRIES_GATE)]["value"],
            true
        );
        assert_eq!(
            gates[&statsig_key(config, LOCAL_AGENT_LOOP_GATE)]["value"],
            false
        );
    }

    #[tokio::test]
    async fn upstream_bootstrap_keeps_the_backend_agent_protocol_for_every_hash_and_frame() {
        for hash in ["none", "djb2", "sha256"] {
            for framed in [false, true] {
                let mut config = json!({
                    "hash_used": hash,
                    "feature_gates": {"unrelated": {"value": true}},
                    "dynamic_configs": {"keep": {"value": 42}},
                    "user": {"userID": "test-user"}
                });
                let local_loop_key = statsig_key(&config, LOCAL_AGENT_LOOP_GATE);
                config["feature_gates"][&local_loop_key] = json!({"value": true});
                let response = proxy::BufferedResponse {
                    status: StatusCode::OK,
                    headers: axum::http::HeaderMap::new(),
                    body: encode_unary(
                        &BootstrapStatsigResponse {
                            config: config.to_string(),
                            generated_at_ms: 123,
                        },
                        framed,
                    ),
                };
                let patched = patch_upstream(response).unwrap();
                let body = to_bytes(patched.into_body(), usize::MAX).await.unwrap();
                let (actual_framed, payload) = unary_payload(&body).unwrap();
                assert_eq!(actual_framed, framed);
                let message = BootstrapStatsigResponse::decode(payload).unwrap();
                let config: Value = serde_json::from_str(&message.config).unwrap();
                assert_backend_agent_loop(&config);
                assert_eq!(config["feature_gates"]["unrelated"]["value"], true);
                assert_eq!(config["dynamic_configs"]["keep"]["value"], 42);
                assert_eq!(config["user"]["userID"], "test-user");
                assert_eq!(message.generated_at_ms, 123);
            }
        }
    }

    #[test]
    fn existing_backend_agent_clients_keep_the_same_execution_mode() {
        for initial_value in [None, Some(false), Some(true)] {
            let mut config = json!({"hash_used": "none", "feature_gates": {}});
            if let Some(enabled) = initial_value {
                config["feature_gates"][LOCAL_AGENT_LOOP_GATE] = json!({"value": enabled});
            }
            configure_agent_runtime(&mut config).unwrap();
            assert_backend_agent_loop(&config);

            let configured = config.clone();
            configure_agent_runtime(&mut config).unwrap();
            assert_eq!(config, configured);
        }
    }

    #[tokio::test]
    async fn offline_bootstrap_also_uses_the_backend_agent_protocol() {
        let response = local_response().unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let message = BootstrapStatsigResponse::decode(body).unwrap();
        let config: Value = serde_json::from_str(&message.config).unwrap();
        assert_backend_agent_loop(&config);
    }
}
