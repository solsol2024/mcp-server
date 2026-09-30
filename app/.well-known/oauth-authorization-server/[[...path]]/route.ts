import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { authorizationServerMetadata } from "@/lib/oauth/metadata";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => authorizationServerMetadata(req);
export const OPTIONS = metadataCorsOptionsRequestHandler();
