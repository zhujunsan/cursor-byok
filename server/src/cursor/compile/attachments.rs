//! Resolves and persists images and documents referenced by Cursor inputs.
use crate::{
    cursor::{protocol::proto::agent::v1 as pb, services::blob_sync::BlobSynchronizer},
    model::ContentPart,
    store::BlobId,
    Error, Result,
};

pub const PDF_MIME_TYPE: &str = "application/pdf";

pub async fn parts(
    message: &pb::UserMessage,
    text: String,
    blobs: &BlobSynchronizer,
) -> Result<Vec<ContentPart>> {
    let mut parts = vec![ContentPart::Text { text }];
    if let Some(context) = &message.selected_context {
        for image in &context.selected_images {
            parts.push(ContentPart::Image {
                mime_type: image_mime_type(image)?,
                data: resolve("image", image_source(image)?, blobs).await?,
            });
        }
        for document in context
            .selected_documents
            .iter()
            .filter(|document| is_pdf(document))
        {
            parts.push(ContentPart::Document {
                mime_type: PDF_MIME_TYPE.into(),
                filename: document_filename(document),
                data: resolve("document", document_source(document)?, blobs).await?,
            });
        }
    }
    Ok(parts)
}

/// Only PDFs are forwarded as provider-native document parts.
pub fn is_pdf(document: &pb::SelectedDocument) -> bool {
    document
        .mime_type
        .trim()
        .eq_ignore_ascii_case(PDF_MIME_TYPE)
}

pub fn document_filename(document: &pb::SelectedDocument) -> String {
    if !document.filename.is_empty() {
        return document.filename.clone();
    }
    std::path::Path::new(&document.path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("document.pdf")
        .into()
}

fn image_mime_type(image: &pb::SelectedImage) -> Result<String> {
    let mime_type = image.mime_type.trim();
    if !mime_type.starts_with("image/") || mime_type.len() == "image/".len() {
        return Err(Error::Protocol(format!(
            "selected image has invalid MIME type: {}",
            image.mime_type
        )));
    }
    Ok(mime_type.into())
}

enum Source<'a> {
    Data(&'a [u8]),
    BlobId(&'a [u8]),
    BlobIdWithData { blob_id: &'a [u8], data: &'a [u8] },
}

fn image_source(image: &pb::SelectedImage) -> Result<Source<'_>> {
    use pb::selected_image::DataOrBlobId;

    match image.data_or_blob_id.as_ref() {
        Some(DataOrBlobId::Data(data)) => Ok(Source::Data(data)),
        Some(DataOrBlobId::BlobId(id)) => Ok(Source::BlobId(id)),
        Some(DataOrBlobId::BlobIdWithData(value)) => Ok(Source::BlobIdWithData {
            blob_id: &value.blob_id,
            data: &value.data,
        }),
        None => Err(Error::Protocol(
            "selected image is missing data_or_blob_id".into(),
        )),
    }
}

fn document_source(document: &pb::SelectedDocument) -> Result<Source<'_>> {
    use pb::selected_document::DataOrBlobId;

    match document.data_or_blob_id.as_ref() {
        Some(DataOrBlobId::Data(data)) => Ok(Source::Data(data)),
        Some(DataOrBlobId::BlobId(id)) => Ok(Source::BlobId(id)),
        Some(DataOrBlobId::BlobIdWithData(value)) => Ok(Source::BlobIdWithData {
            blob_id: &value.blob_id,
            data: &value.data,
        }),
        Some(DataOrBlobId::PromptUploadRef(_)) => Err(Error::Protocol(format!(
            "selected document {} was uploaded to Cursor and cannot be read locally",
            document_filename(document)
        ))),
        None => Err(Error::Protocol(
            "selected document is missing data_or_blob_id".into(),
        )),
    }
}

async fn resolve(label: &str, source: Source<'_>, blobs: &BlobSynchronizer) -> Result<Vec<u8>> {
    let data = match source {
        Source::Data(data) => data.to_vec(),
        Source::BlobId(raw_id) => fetch(label, raw_id, blobs).await?,
        Source::BlobIdWithData { blob_id, data: [] } => fetch(label, blob_id, blobs).await?,
        Source::BlobIdWithData { blob_id, data } => {
            blobs
                .cache_received(&BlobId::from_bytes(blob_id)?, data)
                .await?;
            data.to_vec()
        }
    };
    if data.is_empty() {
        return Err(Error::Protocol(format!("selected {label} data is empty")));
    }
    Ok(data)
}

async fn fetch(label: &str, raw_id: &[u8], blobs: &BlobSynchronizer) -> Result<Vec<u8>> {
    let id = BlobId::from_bytes(raw_id)?;
    blobs.get(&id).await?.ok_or_else(|| {
        Error::Protocol(format!(
            "selected {label} Blob is missing: {}",
            id.to_base64()
        ))
    })
}
