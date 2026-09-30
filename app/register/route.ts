import { handleRegister } from "@/lib/oauth/clients";
import { corsPreflight } from "@/lib/oauth/config";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleRegister(req);
export const OPTIONS = corsPreflight;
