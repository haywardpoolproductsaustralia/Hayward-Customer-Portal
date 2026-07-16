import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { createTicket, listTicketsByEmail } from "@/lib/freshdesk";

// Node runtime required (uses Buffer + server-only module)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/support/tickets — the signed-in user's tickets */
export async function GET() {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const tickets = await listTicketsByEmail(email);
    return NextResponse.json({ tickets });
  } catch (e) {
    console.error("[support] list failed", e);
    return NextResponse.json(
      { error: "Failed to load tickets" },
      { status: 502 }
    );
  }
}

/** POST /api/support/tickets — create a ticket as the signed-in user */
export async function POST(req: Request) {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subject = String(body.subject ?? "").trim();
  const description = String(body.description ?? "").trim();
  const type = body.type ? String(body.type) : undefined;
  const priority =
    typeof body.priority === "number" ? body.priority : undefined;

  if (!subject || !description) {
    return NextResponse.json(
      { error: "Subject and description are required" },
      { status: 400 }
    );
  }

  try {
    const ticket = await createTicket({
      email,
      subject,
      description,
      type,
      priority,
    });
    return NextResponse.json({ ticket }, { status: 201 });
  } catch (e) {
    console.error("[support] create failed", e);
    return NextResponse.json(
      { error: "Failed to create ticket" },
      { status: 502 }
    );
  }
}
