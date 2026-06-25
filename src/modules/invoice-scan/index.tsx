/**
 * Invoice Scan Module — entry point
 *
 * Rendered at /invoices/scan  → ScanUpload
 *             /invoices/inbox → ScanInbox
 *             /invoices/inbox/:id → ScanDetail
 *
 * This file just re-exports the three page components for convenient imports.
 */

export { default as ScanUpload }  from './ScanUpload'
export { default as ScanInbox }   from './ScanInbox'
export { default as ScanDetail }  from './ScanDetail'
