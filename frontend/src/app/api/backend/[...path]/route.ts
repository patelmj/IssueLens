import { NextRequest } from "next/server";

// Fallback is the host-published port (8005, remapped off 8000 to clear mehova);
// under compose, BACKEND_URL is set to http://backend:8000 and wins.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8005";

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const url = new URL(req.url);
  const target = `${BACKEND_URL}/${path.join("/")}${url.search}`;
  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers: {
        "content-type": req.headers.get("content-type") ?? "application/json",
      },
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.arrayBuffer(),
      cache: "no-store",
    });
  } catch {
    return Response.json({ detail: "Backend unreachable" }, { status: 502 });
  }
  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
    },
  });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
