const CODE_REVISION = 'assistant-r9-atomic-preview-20260904';

export async function onRequestGet(context) {
  const { env } = context;
  const commitSha = String(env.CF_PAGES_COMMIT_SHA || env.GIT_COMMIT_SHA || '').trim();
  const branch = String(env.CF_PAGES_BRANCH || '').trim();
  const deploymentUrl = String(env.CF_PAGES_URL || '').trim();

  return Response.json({
    code: 200,
    data: {
      commitSha,
      shortSha: commitSha ? commitSha.slice(0, 8) : '',
      branch,
      deploymentUrl,
      codeRevision: CODE_REVISION,
    },
  }, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
