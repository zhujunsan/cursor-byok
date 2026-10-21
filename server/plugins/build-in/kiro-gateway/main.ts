import { defineProviderPlugin } from "cursor-byok:plugin";
import { gatewayProvider } from "./provider.ts";

export default defineProviderPlugin({ providers: [gatewayProvider] });
