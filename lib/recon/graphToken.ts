/* lib/recon/graphToken.ts
   App-only (client-credentials) token for Microsoft Graph, used to read the
   mailbox that receives the CDS-Net shipment email.

   Azure setup (one-time, done in Entra ID / Azure AD):
     1. App registration -> note the Application (client) ID and Tenant ID.
     2. Certificates & secrets -> new client secret -> note the value.
     3. API permissions -> Microsoft Graph -> Application permission "Mail.Read"
        -> Grant admin consent.
        (Optionally scope it to just the target mailbox with an
         application access policy so the app can't read every inbox.)

   Env vars this reads: GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET
*/

let cached: { token: string; expires: number } | null = null;

export async function getGraphAppToken(): Promise<string> {
  if (cached && Date.now() < cached.expires - 60_000) return cached.token;

  const tenant = process.env.GRAPH_TENANT_ID!;
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID!,
    client_secret: process.env.GRAPH_CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }
  );
  if (!res.ok) throw new Error(`Graph token ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return cached.token;
}
