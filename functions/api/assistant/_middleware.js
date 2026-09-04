const INTERNAL_ONLY_PATHS = new Set([
  '/api/assistant/chat',
  '/api/assistant/chat-memory-core',
]);

export async function onRequest(context) {
  const pathname = new URL(context.request.url).pathname.replace(/\/+$/, '') || '/';

  if (INTERNAL_ONLY_PATHS.has(pathname)) {
    return new Response(JSON.stringify({
      code: 404,
      message: 'Not Found',
    }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return context.next();
}
