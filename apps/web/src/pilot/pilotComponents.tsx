/** Small presentational kit shared by the pilot pages. Pure SVG, no dependencies. */

const TONE_COLORS: Readonly<Record<string, string>> = {
  blue: '#1f55e5', green: '#12996b', amber: '#f59e0b', purple: '#6d4fd8',
  rose: '#e5484d', teal: '#0d9488', indigo: '#4f46e5', slate: '#64748b',
};

export function toneColor(tone: string): string {
  return TONE_COLORS[tone] ?? TONE_COLORS.blue!;
}

export function Ring({ value, size = 84, stroke = 9, tone = 'blue', children }: {
  readonly value: number; readonly size?: number; readonly stroke?: number;
  readonly tone?: string; readonly children?: React.ReactNode;
}): React.ReactElement {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <span style={{ position: 'relative', width: size, height: size, display: 'inline-grid', placeItems: 'center', flex: '0 0 auto' }}>
      <svg width={size} height={size} role="img" aria-label={`${clamped} percent`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#edf1f7" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={toneColor(tone)} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span style={{ position: 'absolute', textAlign: 'center', fontWeight: 700, fontSize: size >= 90 ? 20 : 14 }}>{children ?? `${clamped}%`}</span>
    </span>
  );
}

export function MultiRing({ segments, size = 118, stroke = 13, children }: {
  readonly segments: readonly { readonly value: number; readonly color: string }[];
  readonly size?: number; readonly stroke?: number; readonly children?: React.ReactNode;
}): React.ReactElement {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  let offset = 0;
  return (
    <span style={{ position: 'relative', width: size, height: size, display: 'inline-grid', placeItems: 'center', flex: '0 0 auto' }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#edf1f7" strokeWidth={stroke} />
        {segments.map((segment, index) => {
          const length = (segment.value / total) * circumference;
          const dash = `${Math.max(0, length - 3)} ${circumference}`;
          const element = (
            <circle
              key={index}
              cx={size / 2} cy={size / 2} r={radius} fill="none"
              stroke={segment.color} strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={dash} strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
          offset += length;
          return element;
        })}
      </svg>
      <span style={{ position: 'absolute', textAlign: 'center', fontWeight: 800, fontSize: 19, lineHeight: 1.1 }}>{children}</span>
    </span>
  );
}

export function Spark({ points, height = 96, tone = 'blue' }: {
  readonly points: readonly number[]; readonly height?: number; readonly tone?: string;
}): React.ReactElement {
  const width = 250;
  const max = Math.max(...points, 1);
  const step = width / (points.length - 1 || 1);
  const coords = points.map((point, index) => `${index * step},${height - 12 - (point / max) * (height - 26)}`);
  const color = toneColor(tone);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height }} aria-hidden="true">
      <polyline points={`0,${height} ${coords.join(' ')} ${width},${height}`} fill={`${color}18`} stroke="none" />
      <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      {coords.map((coordinate, index) => {
        const [x, y] = coordinate.split(',');
        return <circle key={index} cx={x} cy={y} r={3} fill="#fff" stroke={color} strokeWidth={2} />;
      })}
    </svg>
  );
}

export function WeekBars({ hours, tone = 'green' }: {
  readonly hours: readonly number[]; readonly tone?: string;
}): React.ReactElement {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const max = Math.max(...hours, 1);
  const color = toneColor(tone);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8, alignItems: 'end', height: 110 }} aria-hidden="true">
      {hours.map((value, index) => (
        <div key={index} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, height: '100%', justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 10, color: '#5d6b82' }}>{value}h</span>
          <span style={{ width: 15, borderRadius: 6, background: color, height: `${Math.max(8, (value / max) * 62)}px` }} />
          <span style={{ fontSize: 10, color: '#5d6b82' }}>{labels[index]}</span>
        </div>
      ))}
    </div>
  );
}
