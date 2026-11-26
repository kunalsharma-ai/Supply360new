import type { AudienceCategory, Permission, ReportKind } from '@s360/contracts';

/**
 * Module 24: the Copilot turns a request into one typed, validated query. This version is deterministic rules, recorded
 * as `copilot-rules-v1`: no model call, no SQL, no commands. Everything it returns is checked again server-side by the
 * same services and permissions the screens use.
 */
export const COPILOT_VERSION = 'copilot-rules-v1';

export type Intent =
  | 'audience_count'
  | 'risk_summary'
  | 'remaining_quota'
  | 'recommend_batch'
  | 'reminder_preview'
  | 'report'
  | 'help'
  | 'refused';

export interface Parsed {
  intent: Intent;
  projectCode?: string;
  audience?: {
    countries?: string[];
    panels?: string[];
    categories?: AudienceCategory[];
    attributes?: { key: string; values: string[] }[];
  };
  report?: { kind: ReportKind; format: 'csv' | 'xlsx' | 'json' };
  rationale: string;
}

export const PERMISSION_FOR: Record<Intent, Permission | null> = {
  audience_count: 'audience.read',
  risk_summary: 'projects.read',
  remaining_quota: 'projects.read',
  recommend_batch: 'projects.read',
  reminder_preview: 'projects.read',
  report: 'reports.export',
  help: null,
  refused: null,
};

const COUNTRIES: Record<string, string> = {
  'united kingdom': 'GB',
  uk: 'GB',
  britain: 'GB',
  'great britain': 'GB',
  england: 'GB',
  'united states': 'US',
  usa: 'US',
  us: 'US',
  america: 'US',
  germany: 'DE',
  france: 'FR',
  spain: 'ES',
  italy: 'IT',
  india: 'IN',
  japan: 'JP',
  canada: 'CA',
  australia: 'AU',
  brazil: 'BR',
  mexico: 'MX',
  netherlands: 'NL',
  sweden: 'SE',
  poland: 'PL',
};
const ISO = new Set(['GB', 'US', 'DE', 'FR', 'ES', 'IT', 'IN', 'JP', 'CA', 'AU', 'BR', 'MX', 'NL', 'SE', 'PL']);

const REFUSE: [RegExp, string][] = [
  [
    /\b(sql|drop\s+table|truncate|delete\s+from|insert\s+into|update\s+\w+\s+set)\b|\bselect\s+[\w*,\s]+\s+from\b/i,
    'The Copilot never runs database queries.',
  ],
  [/\b(shell|terminal|bash|run (a |the )?command|execute (a |the )?command)\b/i, 'The Copilot never runs commands.'],
  [/\b(password|secret|api key|token|credential)s?\b/i, 'The Copilot never reads or shows credentials.'],
  [
    /\b(credit|top ?up|pay)\b.*\b(wallet|reward|points?)\b|\b(wallet|reward|points?)\b.*\b(credit|top ?up)\b/i,
    'Supply360 never credits wallets; rewards are events handed to MADP.',
  ],
  [
    /\b(fake|fabricat\w*|invent\w*|make up|simulate)\b.*\b(complete\w*|respon\w*|data|answers?)\b/i,
    'Completes and answers come only from real participants and SampTrek; nothing is made up.',
  ],
  [
    /\b(proxy|proxies|vpn|antidetect|captcha|rotate ips?|bypass)\b/i,
    'The Copilot does not help evade security or fraud checks.',
  ],
  [
    /\b(e-?mail address\w*|names? of|phone numbers?|personal data|who are the)\b/i,
    'Supply360 holds pseudonymous references only, never personal details.',
  ],
];

const REPORT_WORDS: [RegExp, ReportKind][] = [
  [/synthetic|sampintel/i, 'synthetic_qa'],
  [/funnel|invitation/i, 'invitation_funnel'],
  [/participation|sessions?/i, 'participation'],
  [/quota/i, 'quotas'],
  [/allocation/i, 'allocations'],
  [/selection|audience/i, 'audience_selections'],
  [/redirect/i, 'redirects'],
  [/\bir\b|\bloi\b|incidence|length/i, 'ir_loi'],
  [/quality|flag/i, 'quality'],
  [/reconcil/i, 'reconciliation'],
  [/reward/i, 'reward_events'],
  [/forecast|prediction|delivery/i, 'delivery_forecast'],
  [/audit/i, 'audit'],
  [/summary|project/i, 'project_summary'],
];

export function parse(prompt: string, projectCodes: string[] = []): Parsed {
  const p = prompt.trim();
  for (const [re, why] of REFUSE) if (re.test(p)) return { intent: 'refused', rationale: why };
  const codes = new Map(projectCodes.map((c) => [c.toUpperCase(), c]));
  const codeMatch = p
    .match(/\b([A-Z]{2,6}-?\d{2,})\b/gi)
    ?.map((x) => x.toUpperCase())
    .find((x) => codes.has(x));
  const projectCode = codeMatch ? codes.get(codeMatch) : undefined;
  const has = (re: RegExp) => re.test(p);

  if (has(/\b(report|export|download|excel|xlsx|csv|json|spreadsheet)\b/i)) {
    const kind =
      REPORT_WORDS.find(([re]) => re.test(p.replace(/\b(report|export|download)\b/gi, '')))?.[1] ?? 'project_summary';
    const format = has(/excel|xlsx|spreadsheet/i) ? 'xlsx' : has(/\bjson\b/i) ? 'json' : 'csv';
    return {
      intent: 'report',
      projectCode,
      report: { kind, format },
      rationale: `Asked for an export: matched the ${kind.replaceAll('_', ' ')} report as ${format.toUpperCase()}.`,
    };
  }
  if (has(/remind/i))
    return {
      intent: 'reminder_preview',
      projectCode,
      rationale: 'Asked about reminders: showing pending reminders and when they are due.',
    };
  if (has(/recommend|suggest|next batch|how many invit|invitations? (do we|are) need|allocat/i))
    return {
      intent: 'recommend_batch',
      projectCode,
      rationale: 'Asked for a recommendation: using the delivery forecast inside the project’s execution limits.',
    };
  if (has(/quota|cells?\b|remaining|left to (fill|get)/i))
    return {
      intent: 'remaining_quota',
      projectCode,
      rationale: 'Asked about quotas: listing each open cell against its target.',
    };
  if (has(/risk|on track|behind|late|deadline|deliver|forecast/i))
    return {
      intent: 'risk_summary',
      projectCode,
      rationale: 'Asked about delivery risk: using the delivery forecast.',
    };
  if (has(/how many|count|available|feasib|audience|people|panel(l)?ists|members/i)) {
    const audience = audienceOf(p);
    return {
      intent: 'audience_count',
      audience,
      rationale: `Asked for an audience count: ${describe(audience)}.`,
    };
  }
  return { intent: 'help', projectCode, rationale: 'The request did not match a supported question.' };
}

export function audienceOf(p: string): NonNullable<Parsed['audience']> {
  const lower = ` ${p.toLowerCase()} `;
  const countries = new Set<string>();
  for (const [name, cc] of Object.entries(COUNTRIES)) if (new RegExp(`\\b${name}\\b`).test(lower)) countries.add(cc);
  for (const m of p.match(/\b[A-Z]{2}\b/g) ?? []) if (ISO.has(m)) countries.add(m);
  const panels = new Set<string>();
  if (/turn2opinion|\bt2o\b/i.test(p)) panels.add('t2o');
  if (/\bmfr\b/i.test(p)) panels.add('mfr');
  if (/\bmho\b/i.test(p)) panels.add('mho');
  const categories = new Set<AudienceCategory>();
  if (/consumers?\b/i.test(p)) categories.add('consumer');
  if (/\bb2b\b|business professional|decision makers?/i.test(p)) categories.add('business_professional');
  if (/\bhcps?\b|healthcare professional|doctors?|physicians?|nurses?/i.test(p))
    categories.add('healthcare_professional');
  if (/\bpatients?\b/i.test(p)) categories.add('patient');
  if (/caregivers?|carers?/i.test(p)) categories.add('caregiver');
  const attributes: { key: string; values: string[] }[] = [];
  const g = [
    /\b(women|woman|female|females)\b/i.test(p) && 'female',
    /\b(men|man|male|males)\b/i.test(p) && 'male',
  ].filter(Boolean) as string[];
  if (g.length) attributes.push({ key: 'demographics.gender', values: g });
  const urb = ['urban', 'suburban', 'rural'].filter((u) => new RegExp(`\\b${u}\\b`, 'i').test(p));
  if (urb.length) attributes.push({ key: 'location.urbanicity', values: urb });
  return {
    ...(countries.size ? { countries: [...countries].sort() } : {}),
    ...(panels.size ? { panels: [...panels] } : {}),
    ...(categories.size ? { categories: [...categories] } : {}),
    ...(attributes.length ? { attributes } : {}),
  };
}

export function describe(a: NonNullable<Parsed['audience']>): string {
  const parts = [
    a.countries?.length ? `countries ${a.countries.join(', ')}` : 'all countries',
    a.panels?.length ? `panels ${a.panels.join(', ')}` : 'all panels',
    ...(a.categories?.length ? [`categories ${a.categories.join(', ')}`] : []),
    ...(a.attributes ?? []).map((x) => `${x.key} is ${x.values.join(' or ')}`),
  ];
  return parts.join('; ');
}

export const EXAMPLES = [
  'How many women in the UK and Germany are on Turn2Opinion?',
  'Which projects are at risk?',
  'Remaining quota for PRX10001',
  'Recommend the next batch for PRX10001',
  'Preview reminders for PRX10001',
  'Export the participation report for PRX10001 as Excel',
];
