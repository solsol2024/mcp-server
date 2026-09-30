import { protectedResourceHandler } from "mcp-handler";
import { issuer, json, resourceUrl, SCOPE } from "./config";

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(req: Request) {
  const iss = issuer(req);
  return json(
    {
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/token`,
      registration_endpoint: `${iss}/register`,
      revocation_endpoint: `${iss}/logout`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    },
    200,
    { "Cache-Control": "public, max-age=3600" },
  );
}

/** RFC 9728 protected resource metadata for /mcp. */
export const protectedResourceMetadata = (req: Request) =>
  protectedResourceHandler({ authServerUrls: [issuer(req)], resourceUrl: resourceUrl(req) })(req);
