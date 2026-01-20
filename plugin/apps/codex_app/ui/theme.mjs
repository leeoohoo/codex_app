export const createThemeManager = ({ host, ctx, colors }) => {
  const normalizeTheme = (value) => (String(value || '').toLowerCase() === 'dark' ? 'dark' : 'light');
  const getHostTheme = () => {
    try {
      if (typeof host?.theme?.get === 'function') return host.theme.get();
    } catch {
      // ignore
    }
    return ctx?.theme || document?.documentElement?.dataset?.theme || '';
  };

  let activeTheme = normalizeTheme(getHostTheme());
  let root = null;
  let renderMeta = null;
  const themedSelects = new Set();

  const themeTokens = {
    dark: {
      pageBg:
        'radial-gradient(1200px 700px at 18% 12%, rgba(34,211,238,0.18), transparent 55%), radial-gradient(1000px 600px at 78% 8%, rgba(167,139,250,0.16), transparent 55%), radial-gradient(900px 600px at 30% 90%, rgba(96,165,250,0.10), transparent 55%), linear-gradient(180deg, #05070d 0%, #050913 55%, #05070d 100%)',
      border: 'var(--ds-panel-border, rgba(255,255,255,0.12))',
      borderStrong: 'var(--ds-panel-border, rgba(255,255,255,0.18))',
      bg: 'var(--ds-subtle-bg, rgba(255,255,255,0.06))',
      bgHover: 'var(--ds-selected-bg, rgba(255,255,255,0.09))',
      panel: 'var(--ds-panel-bg, rgba(255,255,255,0.04))',
      panelHover: 'var(--ds-panel-bg, rgba(255,255,255,0.06))',
      logBg: 'var(--ds-code-bg, rgba(0,0,0,0.55))',
      textMuted: 'rgba(255,255,255,0.70)',
      textStrong: 'rgba(255,255,255,0.92)',
      accent: 'var(--ds-accent, #22d3ee)',
      accent2: 'var(--ds-accent-2, #a78bfa)',
      accentBorder: 'var(--ds-accent, rgba(34,211,238,0.55))',
      accentGlow: 'rgba(34,211,238,0.16)',
      gridOpacity: '0.12',
      danger: '#ef4444',
      dangerBorder: 'rgba(239,68,68,0.55)',
      dangerBg: 'rgba(239,68,68,0.12)',
      dangerBgHover: 'rgba(239,68,68,0.16)',
      primaryText: '#071018',
      shadow: '0 22px 70px rgba(0,0,0,0.45)',
      panelShadow: 'var(--ds-panel-shadow, 0 16px 50px rgba(0,0,0,0.35))',
      titleGlow: '0 0 22px rgba(34,211,238,0.20)',
    },
    light: {
      pageBg:
        'radial-gradient(1200px 700px at 18% 12%, rgba(37,99,235,0.12), transparent 58%), radial-gradient(900px 600px at 78% 8%, rgba(6,182,212,0.10), transparent 55%), linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)',
      border: 'var(--ds-panel-border, rgba(0,0,0,0.12))',
      borderStrong: 'var(--ds-panel-border, rgba(0,0,0,0.18))',
      bg: 'var(--ds-subtle-bg, rgba(0,0,0,0.04))',
      bgHover: 'var(--ds-selected-bg, rgba(0,0,0,0.06))',
      panel: 'var(--ds-panel-bg, rgba(0,0,0,0.02))',
      panelHover: 'var(--ds-panel-bg, rgba(0,0,0,0.04))',
      logBg: 'var(--ds-code-bg, rgba(255,255,255,0.75))',
      textMuted: 'rgba(0,0,0,0.65)',
      textStrong: 'rgba(0,0,0,0.92)',
      accent: 'var(--ds-accent, #2563eb)',
      accent2: 'var(--ds-accent-2, #06b6d4)',
      accentBorder: 'var(--ds-accent, rgba(37,99,235,0.55))',
      accentGlow: 'rgba(37,99,235,0.16)',
      gridOpacity: '0.06',
      danger: '#ef4444',
      dangerBorder: 'rgba(239,68,68,0.55)',
      dangerBg: 'rgba(239,68,68,0.10)',
      dangerBgHover: 'rgba(239,68,68,0.12)',
      primaryText: '#ffffff',
      shadow: '0 18px 55px rgba(2,6,23,0.12)',
      panelShadow: 'var(--ds-panel-shadow, 0 14px 40px rgba(2,6,23,0.10))',
      titleGlow: '0 0 18px rgba(37,99,235,0.12)',
    },
  };

  const applySelectTheme = (select) => {
    if (!select) return;
    select.style.colorScheme = activeTheme;
    select.style.background = colors.bg;
    select.style.color = colors.textStrong;
    select.style.borderColor = colors.borderStrong;
    const options = select.querySelectorAll('option');
    options.forEach((opt) => {
      opt.style.background = colors.panel;
      opt.style.color = colors.textStrong;
    });
  };

  const applyTheme = (theme) => {
    const nextTheme = normalizeTheme(theme);
    activeTheme = nextTheme;
    const palette = themeTokens[nextTheme] || themeTokens.light;
    if (root) {
      root.dataset.theme = nextTheme;
      root.style.setProperty('--codex-page-bg', palette.pageBg);
      root.style.setProperty('--codex-border', palette.border);
      root.style.setProperty('--codex-border-strong', palette.borderStrong);
      root.style.setProperty('--codex-bg', palette.bg);
      root.style.setProperty('--codex-bg-hover', palette.bgHover);
      root.style.setProperty('--codex-panel', palette.panel);
      root.style.setProperty('--codex-panel-hover', palette.panelHover);
      root.style.setProperty('--codex-log-bg', palette.logBg);
      root.style.setProperty('--codex-text-muted', palette.textMuted);
      root.style.setProperty('--codex-text-strong', palette.textStrong);
      root.style.setProperty('--codex-accent', palette.accent);
      root.style.setProperty('--codex-accent-2', palette.accent2);
      root.style.setProperty('--codex-accent-border', palette.accentBorder);
      root.style.setProperty('--codex-accent-glow', palette.accentGlow);
      root.style.setProperty('--codex-grid-opacity', palette.gridOpacity);
      root.style.setProperty('--codex-danger', palette.danger);
      root.style.setProperty('--codex-danger-border', palette.dangerBorder);
      root.style.setProperty('--codex-danger-bg', palette.dangerBg);
      root.style.setProperty('--codex-danger-bg-hover', palette.dangerBgHover);
      root.style.setProperty('--codex-primary-text', palette.primaryText);
      root.style.setProperty('--codex-shadow', palette.shadow);
      root.style.setProperty('--codex-panel-shadow', palette.panelShadow);
      root.style.setProperty('--codex-title-glow', palette.titleGlow);
    }
    if (renderMeta) renderMeta(nextTheme);
    themedSelects.forEach((select) => applySelectTheme(select));
  };

  const setRoot = (node) => {
    root = node;
    applyTheme(activeTheme);
  };

  const setRenderMeta = (fn) => {
    renderMeta = typeof fn === 'function' ? fn : null;
  };

  const subscribe = () => {
    if (typeof host?.theme?.onChange === 'function') {
      return host.theme.onChange((theme) => applyTheme(theme));
    }
    return null;
  };

  const registerSelect = (select) => {
    if (!select) return;
    themedSelects.add(select);
    applySelectTheme(select);
  };

  return {
    applyTheme,
    applySelectTheme,
    registerSelect,
    themedSelects,
    setRenderMeta,
    setRoot,
    subscribe,
    getActiveTheme: () => activeTheme,
  };
};
