import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from './theme';
import { fmtDuration } from './progress';

/** A dependency-free bar chart (Views only), so it renders the same on web and native. */
export default function BarChart({ data, height = 110 }: { data: { label: string; value: number }[]; height?: number }) {
  const max = Math.max(1, ...data.map(d => d.value));
  const last = data.length - 1;
  return (
    <View>
      <View style={[s.bars, { height: height + 18 }]}>
        {data.map((d, i) => (
          <View key={i} style={s.col}>
            <Text style={s.value}>{d.value > 0 ? fmtDuration(d.value) : ''}</Text>
            <View
              style={[
                s.bar,
                { height: d.value > 0 ? Math.max(3, Math.round((d.value / max) * height)) : 2 },
                i === last && d.value > 0 && { backgroundColor: COLORS.accentLight },
                d.value === 0 && { backgroundColor: COLORS.border },
              ]}
            />
          </View>
        ))}
      </View>
      <View style={s.labels}>
        {data.map((d, i) => <Text key={i} numberOfLines={1} style={s.label}>{d.label}</Text>)}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  col: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '70%', minWidth: 8, borderRadius: 4, backgroundColor: COLORS.accent },
  value: { fontSize: 9, color: COLORS.textMuted, marginBottom: 3 },
  labels: { flexDirection: 'row', gap: 6, marginTop: 6 },
  label: { flex: 1, fontSize: 10, color: COLORS.textMuted, textAlign: 'center' },
});
