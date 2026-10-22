import { BarSeriesModule, CategoryAxisModule, LegendModule, LocaleModule, ModuleRegistry, NumberAxisModule, type AgChartTheme } from 'ag-charts-community';

// Imported only by chart components, so AG Charts stays out of the main bundle. Only what the
// charts use is registered: bar series (it brings the cartesian chart), their axes, the legend
// and default texts. Tooltips are built in.
ModuleRegistry.registerModules([BarSeriesModule, CategoryAxisModule, NumberAxisModule, LegendModule, LocaleModule]);

/**
 * Categorical slots in a fixed order (validated for colour-blind separation on a light
 * surface). Colour follows the entity: callers give each series a stable slot.
 */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
/** "What the publisher keeps": neutral, so contributors carry the colour. */
export const KEPT_COLOR = '#94a3b8';

export const chartTheme: AgChartTheme = {
  baseTheme: 'ag-default',
  params: {
    fontFamily: "'Inter Variable', Inter, ui-sans-serif, system-ui, sans-serif",
    fontSize: 12,
    backgroundColor: 'transparent',
    foregroundColor: '#0f172a',
    textColor: '#334155',
    subtleTextColor: '#64748b',
    axisLineColor: '#cbd5e1',
    gridLineColor: '#eef2f7',
  },
  overrides: {
    bar: { series: { cornerRadius: 4, strokeWidth: 2, stroke: '#ffffff' } },
  },
};
