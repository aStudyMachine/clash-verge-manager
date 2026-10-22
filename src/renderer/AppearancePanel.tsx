import {
  FONT_SIZES,
  setFont,
  setTheme,
  useAppearance,
  type FontSize,
  type ThemeMode,
} from './appearance.js';

const themes: { value: ThemeMode; label: string; note: string }[] = [
  { value: 'system', label: '跟随系统', note: '随系统切换' },
  { value: 'light', label: '亮色', note: 'GitHub Light' },
  { value: 'dark', label: '暗色', note: 'GitHub Dimmed' },
];

const fontNotes: Record<FontSize, string> = { 13: '小', 14: '标准', 16: '大', 18: '特大' };

export function AppearancePanel() {
  const appearance = useAppearance();
  return (
    <div className="appearance-panel">
      <section>
        <div className="appearance-heading">
          <h3>主题</h3>
          <span>黑白双主题，默认跟随系统</span>
        </div>
        <div className="segmented" role="group" aria-label="主题">
          {themes.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={appearance.theme === option.value}
              onClick={() => setTheme(option.value)}
            >
              <span className={`theme-swatch ${option.value}`} aria-hidden="true" />
              <span className="segmented-label">
                <strong>{option.label}</strong>
                <small>{option.note}</small>
              </span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <div className="appearance-heading">
          <h3>字号</h3>
          <span>整套界面随档位缩放，最小文字 12px</span>
        </div>
        <div className="segmented font-options" role="group" aria-label="字号">
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              aria-pressed={appearance.font === size}
              onClick={() => setFont(size)}
            >
              <strong className="font-sample" aria-hidden="true" style={{ fontSize: `${size}px` }}>
                Aa
              </strong>
              <span className="segmented-label">
                <strong>{fontNotes[size]}</strong>
                <small>{size}px</small>
              </span>
            </button>
          ))}
        </div>
      </section>
      <div className="appearance-preview">
        <strong>预览</strong>
        <p>节点名称、规则、表格与按钮会一起缩放，不会只放大正文。</p>
        <small>外观偏好只保存在本机，不随方案或 Git 同步。</small>
      </div>
    </div>
  );
}
