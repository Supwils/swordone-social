import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';

/**
 * Tiny line chart for inline use (agent cards, drift widget).
 * No axes, no tooltip — pure shape. Recharts is overkill for this but
 * we're already paying for it on the detail view, so reuse.
 */
export function Sparkline({
  data,
  color = 'var(--color-accent)',
  strokeWidth = 1.5,
}: {
  data: Array<{ v: number }>;
  color?: string;
  strokeWidth?: number;
}) {
  const { t } = useTranslation();
  if (data.length < 2) {
    return (
      <div style={{ width: '100%', height: '100%', opacity: 0.4, fontSize: 11 }}>
        {t('lab.sparklineEmpty')}
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        {/* Force Y to start at 0 so the line shape reads as "growing drift" */}
        <YAxis hide domain={[0, 'auto']} />
        <Line
          type="monotone"
          dataKey="v"
          stroke={color}
          strokeWidth={strokeWidth}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
