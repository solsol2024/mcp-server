import { corsPreflight } from "@/lib/oauth/config";
import { handleToken } from "@/lib/oauth/tokens";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleToken(req);
export const OPTIONS = corsPreflight;
