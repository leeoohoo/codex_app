export const createDomHelpers = ({ colors, registerSelect }) => {
  const el = (tag, style) => {
    const node = document.createElement(tag);
    if (style && typeof style === 'object') Object.assign(node.style, style);
    return node;
  };

  const mkBtn = (label, { variant = 'default' } = {}) => {
    const isPrimary = variant === 'primary';
    const isDanger = variant === 'danger';
    const btn = el('button', {
      padding: '9px 10px',
      borderRadius: '12px',
      border: `1px solid ${isPrimary ? colors.accentBorder : isDanger ? colors.dangerBorder : colors.borderStrong}`,
      background: isPrimary
        ? `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accent2} 80%)`
        : isDanger
          ? colors.dangerBg
          : colors.bg,
      cursor: 'pointer',
      fontWeight: '650',
      color: isPrimary ? colors.primaryText : isDanger ? colors.danger : colors.textStrong,
    });
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('mouseenter', () => {
      if (isPrimary) btn.style.filter = 'brightness(1.05)';
      else if (isDanger) btn.style.background = colors.dangerBgHover;
      else btn.style.background = colors.bgHover;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.filter = '';
      btn.style.background = isPrimary
        ? `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accent2} 80%)`
        : isDanger
          ? colors.dangerBg
          : colors.bg;
    });
    return btn;
  };

  const mkInput = (placeholder) => {
    const input = el('input', {
      width: '100%',
      boxSizing: 'border-box',
      padding: '9px 10px',
      borderRadius: '12px',
      border: `1px solid ${colors.borderStrong}`,
      background: colors.bg,
      outline: 'none',
      color: colors.textStrong,
    });
    input.type = 'text';
    input.placeholder = placeholder || '';
    return input;
  };

  const mkSelect = (options) => {
    const select = el('select', {
      width: '100%',
      boxSizing: 'border-box',
      padding: '9px 10px',
      borderRadius: '12px',
      border: `1px solid ${colors.borderStrong}`,
      background: colors.bg,
      outline: 'none',
      color: colors.textStrong,
    });
    for (const opt of Array.isArray(options) ? options : []) {
      const o = document.createElement('option');
      o.value = String(opt?.value ?? '');
      o.textContent = String(opt?.label ?? opt?.value ?? '');
      select.appendChild(o);
    }
    if (registerSelect) registerSelect(select);
    return select;
  };

  const mkCheckbox = (label) => {
    const wrap = el('label', { display: 'flex', alignItems: 'center', gap: '8px', userSelect: 'none' });
    const input = document.createElement('input');
    input.type = 'checkbox';
    const text = el('div', { fontSize: '12px', color: colors.textMuted });
    text.textContent = label || '';
    wrap.appendChild(input);
    wrap.appendChild(text);
    return { wrap, input };
  };

  const mkField = (title, control, { hint = '', fullWidth = false } = {}) => {
    const wrap = el('div', { display: 'flex', flexDirection: 'column', gap: '6px' });
    const titleEl = el('div', { fontSize: '12px', color: colors.textMuted, fontWeight: '650' });
    titleEl.textContent = title || '';
    wrap.appendChild(titleEl);
    wrap.appendChild(control);
    if (hint) {
      const hintEl = el('div', { fontSize: '12px', color: colors.textMuted, lineHeight: '1.4' });
      hintEl.textContent = hint;
      wrap.appendChild(hintEl);
    }
    if (fullWidth) wrap.style.gridColumn = '1 / -1';
    return wrap;
  };

  const mkGroup = (title, { subtitle = '', compact = false } = {}) => {
    const groupPadding = compact ? '8px 10px' : '12px';
    const groupGap = compact ? '6px' : '10px';
    const headGap = compact ? '6px' : '10px';
    const bodyGap = compact ? '8px' : '10px';
    const wrap = el('div', {
      border: `1px solid ${colors.border}`,
      borderRadius: '14px',
      background: colors.panelHover,
      padding: groupPadding,
      display: 'flex',
      flexDirection: 'column',
      gap: groupGap,
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
    });
    const head = el('div', {
      display: 'flex',
      alignItems: compact ? 'center' : 'baseline',
      justifyContent: 'space-between',
      gap: headGap,
      flexWrap: 'wrap',
    });
    const h = el('div', { fontWeight: '850', color: colors.textStrong, letterSpacing: '0.2px', fontSize: compact ? '13px' : '' });
    h.textContent = title || '';
    head.appendChild(h);
    if (subtitle) {
      const s = el('div', { fontSize: compact ? '11px' : '12px', color: colors.textMuted });
      s.textContent = subtitle;
      head.appendChild(s);
    }
    const body = el('div', { display: 'grid', gap: bodyGap });
    wrap.appendChild(head);
    wrap.appendChild(body);
    return { wrap, body };
  };

  const styleCheckboxCard = (wrap) => {
    Object.assign(wrap.style, {
      border: `1px solid ${colors.borderStrong}`,
      borderRadius: '12px',
      background: colors.bg,
      padding: '10px 10px',
      boxSizing: 'border-box',
      minHeight: '40px',
    });
  };

  const mkBadge = (text, { fg = colors.textMuted, bg = 'transparent', border = colors.borderStrong } = {}) => {
    const badge = el('div', {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2px 8px',
      borderRadius: '999px',
      border: `1px solid ${border}`,
      color: fg,
      background: bg,
      fontSize: '11px',
      fontWeight: '750',
      lineHeight: '1.4',
      userSelect: 'none',
      whiteSpace: 'nowrap',
    });
    badge.textContent = String(text || '');
    return badge;
  };

  const mkTag = (text, { fg = colors.textStrong, bg = colors.bg, border = colors.accentBorder } = {}) => {
    const tag = mkBadge(text, { fg, bg, border });
    tag.style.cursor = 'pointer';
    return tag;
  };

  return {
    el,
    mkBtn,
    mkInput,
    mkSelect,
    mkCheckbox,
    mkField,
    mkGroup,
    styleCheckboxCard,
    mkBadge,
    mkTag,
  };
};
