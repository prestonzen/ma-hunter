/**
 * The charts here answer "how many": one series, one hue, so there is no legend to read. Each bar
 * carries its number beside it in ink (never in the bar colour), and a title for hover.
 */

export interface BarRow {
  label: string;
  value: number;
  note?: string;
}

export function Bars({ rows, empty = "Nothing yet" }: { rows: BarRow[]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length || rows.every((r) => r.value === 0)) return <p className="muted small">{empty}</p>;
  return (
    <div className="bars" role="table">
      {rows.map((r) => (
        <div className="bar-row" role="row" key={r.label} title={`${r.label}: ${r.value.toLocaleString()}${r.note ? ` (${r.note})` : ""}`}>
          <span className="lbl" role="cell">
            {r.label}
          </span>
          <span className="bar-track" role="presentation">
            {r.value > 0 && <div className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />}
          </span>
          <span className="v" role="cell">
            {r.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Counts over time as thin columns; first and last labels mark the range. */
export function Columns({ points, unit }: { points: { label: string; value: number }[]; unit: string }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  if (!points.length) return <p className="muted small">Nothing yet</p>;
  return (
    <div>
      <div className="cols" role="img" aria-label={`${unit} over time: ${points.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
        {points.map((p) => (
          <div key={p.label} className="c" style={{ height: `${Math.max(2, (p.value / max) * 100)}%` }} title={`${p.label}: ${p.value} ${unit}`} />
        ))}
      </div>
      <div className="cols-x">
        <span>{points[0].label}</span>
        <span>
          peak {max} {unit}
        </span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}

export function Meter({ value, max, title }: { value: number; max: number; title?: string }) {
  return (
    <div className="meter" title={title} role="presentation">
      <i style={{ width: `${max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0}%` }} />
    </div>
  );
}
