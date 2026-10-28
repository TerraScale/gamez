/**
 * Admin wire shapes shared by routes/admin.ts and the dashboard client.
 * OWNER: T-admin. Types only, so the client can import it without pulling
 * server code.
 */

/** GET /api/admin/me (any logged-in caller; anonymous is 401). */
export interface AdminMe {
  admin: boolean;
  /** Where the admin right comes from (admins only). */
  via?: "env" | "dev";
  accountId?: string;
  /** True where POST /api/dev/admin/self exists (isDevHost on the server). */
  devHost: boolean;
}
