import { corsPreflight } from "@/lib/oauth/config";
import { handleLogout } from "@/lib/oauth/tokens";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleLogout(req);
export const OPTIONS = corsPreflight;
