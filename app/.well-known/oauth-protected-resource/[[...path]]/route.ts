import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { protectedResourceMetadata } from "@/lib/oauth/metadata";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => protectedResourceMetadata(req);
export const OPTIONS = metadataCorsOptionsRequestHandler();
