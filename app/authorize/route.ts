import { handleAuthorizeGet, handleAuthorizePost } from "@/lib/oauth/authorize";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => handleAuthorizeGet(req);
export const POST = (req: Request) => handleAuthorizePost(req);
