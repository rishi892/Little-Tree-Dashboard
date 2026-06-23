// Where-in-the-app map for the Review/Audit location picker. Keys are the page
// titles (the same strings the sidebar/Topbar use as `activePage`), so the
// picker can default to wherever the reviewer currently is. Each page lists its
// tabs; a tab with sub-tabs lists them so the reviewer can pinpoint exactly
// "Section › Tab › Sub-tab" where something looks wrong.
export const REVIEW_LOCATIONS = {
  'Overview': {},
  'Little Tree Accounts receivable': {
    'Action List': [],
    'To Agency': [],
    'Aging': [],
    'Trends': [],
    'DSO': ['Trend', 'By Rep', 'By Customer', 'By Brand'],
    'Private Label': [],
    'By Year': [],
    'Reconciliation': [],
  },
  'Gelato Accounts receivable': {
    'Action List': [],
    'To Agency': [],
    'Aging': [],
    'Trends': [],
    'DSO': ['Trend', 'By Customer', 'By Brand'],
    'By Year': [],
  },
  'Little Tree Sales': {
    'Overview': [],
    'Concentration': [],
    'Seasonality': [],
    'Brand Mix': [],
    'Rep Scorecard': [],
    'Geography': [],
  },
  'Little Tree Customers': {
    'All Customers': [],
    'Brands': [],
    'Reorder Cadence': [],
    'At-Risk': [],
    'Customer Health': [],
    'Payment Behavior': [],
  },
  'Gelato Customers': {
    'All Customers': [],
    'Reorder Cadence': [],
    'At-Risk': [],
    'Customer Health': [],
    'Payment Behavior': [],
  },
}

// Sections a user may pick from, matching their dashboard access. Sales/LT staff
// don't see Gelato sections, Gelato users don't see Little Tree sections, etc.
const ROLE_SECTIONS = {
  'gelato-only': ['Gelato Accounts receivable', 'Gelato Customers'],
  'little-tree-only': ['Overview', 'Little Tree Accounts receivable', 'Little Tree Sales', 'Little Tree Customers'],
}
export function allowedSections(role) {
  const all = Object.keys(REVIEW_LOCATIONS)
  const allowed = ROLE_SECTIONS[role]
  return allowed ? all.filter((s) => allowed.includes(s)) : all
}

// "Section › Tab › Sub-tab" - for displaying a saved review's location.
export function locationBreadcrumb(r) {
  return [r.section, r.tab, r.subtab].filter(Boolean).join(' › ')
}
