import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';

// Imported only by grid pages, so AG Grid stays out of the main bundle.
ModuleRegistry.registerModules([AllCommunityModule]);

export const gridTheme = themeQuartz.withParams({
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  fontSize: 13,
  headerFontWeight: 600,
  headerBackgroundColor: '#f8fafc',
  borderColor: '#e2e8f0',
  rowBorder: { color: '#eef2f7' },
  accentColor: '#0d9488',
  wrapperBorderRadius: 12,
  spacing: 7,
});
