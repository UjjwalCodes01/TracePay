import {
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  CsvExportModule,
  DateFilterModule,
  HighlightChangesModule,
  ModuleRegistry,
  NumberFilterModule,
  PinnedRowModule,
  QuickFilterModule,
  RowSelectionModule,
  TextEditorModule,
  TextFilterModule,
  TooltipModule,
  ValidationModule,
  themeQuartz,
} from 'ag-grid-community';

// Imported only by grid pages, so AG Grid stays out of the main bundle. Only the features
// the grids use are registered (each checked against AG Grid's own option→module table).
ModuleRegistry.registerModules([
  ClientSideRowModelModule, // rowData
  ClientSideRowModelApiModule, // api.forEachNodeAfterFilter (ledger totals)
  CellStyleModule, // cellClass
  TextEditorModule, // editable prices in the simulator
  HighlightChangesModule, // enableCellChangeFlash
  TextFilterModule, // agTextColumnFilter + floating filters
  NumberFilterModule, // agNumberColumnFilter
  DateFilterModule, // agDateColumnFilter
  QuickFilterModule, // quickFilterText (search boxes)
  TooltipModule, // tooltipField / headerTooltip
  PinnedRowModule, // pinnedBottomRowData (totals)
  RowSelectionModule, // registry row selection
  CsvExportModule, // exportDataAsCsv
  // Development only: explains any missing module in the console instead of failing silently.
  ...(import.meta.env.DEV ? [ValidationModule] : []),
]);

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
