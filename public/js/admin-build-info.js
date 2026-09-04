(function () {
  if (window.IoriBuildInfo) return;

  async function loadBuildInfo() {
    try {
      const response = await fetch('/api/build-info', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || payload.code !== 200 || !payload.data) return;

      const info = payload.data;
      const label = info.shortSha || info.codeRevision || 'unknown';
      let badge = document.getElementById('ioriBuildInfoBadge');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'ioriBuildInfoBadge';
        Object.assign(badge.style, {
          position: 'fixed',
          left: '10px',
          bottom: '8px',
          zIndex: '3200',
          padding: '4px 7px',
          borderRadius: '7px',
          background: 'rgba(255,255,255,.92)',
          border: '1px solid #e2e8f0',
          boxShadow: '0 2px 10px rgba(15,23,42,.08)',
          color: '#64748b',
          fontSize: '10px',
          lineHeight: '1.2',
          fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
          userSelect: 'text',
        });
        document.body.appendChild(badge);
      }

      badge.textContent = `Build ${label}`;
      badge.title = [
        info.commitSha ? `Commit: ${info.commitSha}` : '',
        info.branch ? `Branch: ${info.branch}` : '',
        info.codeRevision ? `Code: ${info.codeRevision}` : '',
        info.deploymentUrl ? `Pages: ${info.deploymentUrl}` : '',
      ].filter(Boolean).join('\n');
    } catch (error) {
      console.warn('Failed to load build info:', error);
    }
  }

  window.IoriBuildInfo = { load: loadBuildInfo };
  loadBuildInfo();
})();
