// Browser end-to-end check on a running stack (API + web) with the DEMO tenant seeded.
// Usage: E2E_PASSWORD=… [E2E_BASE_URL=http://localhost:3000] [SCREENSHOTS=dir] node e2e/smoke.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { Secret, TOTP } from 'otpauth';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.E2E_PASSWORD;
const SHOTS = process.env.SCREENSHOTS;
if (!PASSWORD) throw new Error('E2E_PASSWORD is required');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

async function axe(label) {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const out = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag22aa'] });
    return out.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map(
        (v) =>
          `${v.id}(${v.nodes.length}): ${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(' '))
            .join(' ; ')}`,
      );
  });
  check(`axe: no serious or critical issues on ${label}`, r.length === 0, r.join(', '));
}
const shot = (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

// 1. Unauthenticated visit goes to sign-in
await page.goto(`${BASE}/users`);
await page.waitForURL(/\/login/);
check('signed-out visit redirects to /login with next', page.url().includes('next=%2Fusers'));
await axe('sign-in');
await shot('01-login');

// 2. Wrong password is refused with a message
await page.fill('#tenant', 'demo');
await page.fill('#email', 'tenant_admin@demo.example.invalid');
await page.fill('#password', 'wrong-password-000');
await page.click('button[type=submit]');
check('wrong password shows an error', await page.getByRole('alert').isVisible());

// 3. Correct password → MFA enrol (first time) or challenge
await page.fill('#password', PASSWORD);
await page.click('button[type=submit]');
await page.waitForSelector('#code');
const secretText = await page
  .locator('code.font-mono')
  .first()
  .textContent()
  .catch(() => null);
const secret = secretText?.trim() || process.env.E2E_TOTP_SECRET;
if (!secret) throw new Error('Account already enrolled: set E2E_TOTP_SECRET');
console.log(`TOTP secret for this run: ${secret.slice(0, 4)}…`);
await shot('02-mfa-setup');
await page.fill('#code', new TOTP({ secret: Secret.fromBase32(secret), period: 30, digits: 6 }).generate());
await page.click('button[type=submit]');
await page.waitForURL(`${BASE}/users`);
check('MFA completes and returns to the page asked for', page.url().endsWith('/users'));
await page.getByRole('heading', { name: 'Users and roles' }).waitFor();
await page.locator('tbody tr').first().waitFor();
check('users page lists the DEMO accounts', (await page.locator('tbody tr').count()) >= 11);
await axe('users');
await shot('04-users');

// 4. Command centre, honest empty states
await page.goto(`${BASE}/`);
await page.getByText('Integration health').waitFor();
await page.getByText('PRX10001').first().waitFor();
check('command centre lists the imported FIXTURE projects', (await page.getByText('FIXTURE ·').count()) >= 3);
await axe('command centre');
await shot('03-command-centre');

// 5. Command palette with keyboard
await page.keyboard.press('Control+k');
await page.getByPlaceholder('Search modules, settings and commands…').fill('audit');
await page.keyboard.press('Enter');
await page.waitForURL(`${BASE}/audit`);
check('⌘K palette navigates by keyboard', page.url().endsWith('/audit'));
await page.locator('tbody tr').first().waitFor();
check('audit log shows the sign-in entries', (await page.getByText('auth.mfa_enrolled').count()) > 0);
await axe('audit');
await shot('05-audit');

// 6. Create a person through the dialog
await page.goto(`${BASE}/users`);
await page.getByRole('button', { name: 'Add person' }).click();
const stamp = Date.now();
await page.fill('#n-name', 'DEMO New Analyst');
await page.fill('#n-email', `analyst-${stamp}@demo.example.invalid`);
await page.fill('#n-pass', 'demo-analyst-password-1');
await page.getByRole('checkbox', { name: 'Quality Analyst' }).check();
await page.getByRole('dialog').getByRole('button', { name: 'Add person' }).click();
await page.getByText(`analyst-${stamp}@demo.example.invalid`).waitFor();
check('a new person can be added from the UI', true);

// 7. Settings, security, planned module, roles tab
await page.goto(`${BASE}/settings`);
await page.getByLabel('Display name').waitFor();
await axe('settings');
await shot('06-settings');
await page.goto(`${BASE}/security`);
await page.getByText('Controls').first().waitFor();
await axe('security');
await shot('07-security');
await page.goto(`${BASE}/audience/filter`);
await page.getByText('Arrives in Phase 3').waitFor();
check('a module not built yet shows its phase, not a mock', true);
await shot('08-planned-module');

// 7b. Phase 2: projects from SampTrek (FIXTURE), lifecycle, signed webhooks, redirects
await page.goto(`${BASE}/projects`);
await page.locator('tbody tr').first().waitFor();
check('projects list shows the imported FIXTURE projects', (await page.locator('tbody tr').count()) >= 3);
check(
  'a project on hold at SampTrek starts held in Supply360',
  await page.getByText('On hold at source').first().isVisible(),
);
await axe('projects');
await shot('11-projects');

await page.getByRole('link', { name: /Grocery shopper tracker/ }).click();
await page.getByRole('heading', { name: 'Launch checks' }).waitFor();
check(
  'Mark ready is blocked until entry links are approved',
  await page.getByRole('button', { name: 'Mark ready' }).isDisabled(),
);
for (const cc of ['GB', 'US']) {
  await page
    .getByRole('row', { name: new RegExp(`^${cc}`) })
    .getByRole('button', { name: 'Approve' })
    .click();
  await page.fill('#entryUrl', `https://samptrek.example/s/FX${cc}?uid=[UID]`);
  await page.getByRole('dialog').getByRole('button', { name: 'Approve link' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
await page.getByText('Needs approval').waitFor({ state: 'detached' });
for (const [action, label] of [
  ['Mark ready', 'Ready to launch'],
  ['Launch', 'Live'],
]) {
  await page.getByRole('toolbar').getByRole('button', { name: action }).click();
  await page.fill('#reason', `E2E ${action.toLowerCase()}`);
  await page.getByRole('dialog').getByRole('button', { name: action }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByText(label, { exact: true }).first().waitFor();
}
check('after approval a person can mark ready and launch', await page.getByText('Dispatch allowed').isVisible());
await axe('project detail');
await shot('12-project-detail');

await page.goto(`${BASE}/integrations/samptrek`);
await page.getByText('Webhook URL for SampTrek').waitFor();
await axe('SampTrek integration');
await shot('13-samptrek');
await page.selectOption('#sim-project', 'PRX10001');
await page.selectOption('#sim-status', 'HOLD');
await page.getByRole('button', { name: 'Send signed webhook' }).click();
await page.getByText('Signed webhook delivered').waitFor();
await page.goto(`${BASE}/projects`);
await page.getByRole('link', { name: /Grocery shopper tracker/ }).click();
await page.getByText('Dispatch stopped').waitFor();
check(
  'a signed HOLD from SampTrek stops dispatch',
  await page.getByText('SampTrek has put this project on hold').isVisible(),
);
await shot('14-project-source-hold');

await page.goto(`${BASE}/developers`);
await page.getByText('project.status_changed').first().waitFor();
check('the webhook log shows the processed delivery', (await page.getByText('processed').count()) > 0);
await axe('webhook log');
await shot('15-webhook-log');

await page.goto(`${BASE}/redirects`);
await page.getByText('QUOTA_FULL').waitFor();
check(
  'redirect management lists all 8 SampTrek outcomes',
  (await page.getByRole('button', { name: /^Copy .* URL$/ }).count()) === 8,
);
await axe('redirects');
await shot('16-redirects');

await page.goto(`${BASE}/integrations/sampcloud`);
await page.getByText('Blocked in Phase 2').waitFor();
check('SampCloud shows it is blocked, not a mock', true);

const done = await ctx.newPage();
await done.goto(`${BASE}/done/quota-full`);
check(
  'respondent landing page works without signing in',
  await done.getByRole('heading', { name: 'This survey is full' }).isVisible(),
);
await done.close();

// 8. Themes
for (const [i, t] of ['arctic', 'violet', 'emerald', 'midnight'].entries()) {
  await page.evaluate((id) => localStorage.setItem('s360-theme', id), t);
  await page.goto(`${BASE}/`);
  await page.getByText('Integration health').waitFor();
  check(`theme ${t} applies`, (await page.evaluate(() => document.documentElement.dataset.theme)) === t);
  if (t !== 'midnight') await axe(`command centre (${t})`);
  await shot(`09-theme-${i + 1}-${t}`);
}

// 9. Phone width
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/`);
await page.getByRole('button', { name: 'Open navigation' }).click();
await page.getByRole('dialog').getByRole('link', { name: 'User and Role Management' }).click();
await page.waitForURL(`${BASE}/users`);
check('mobile navigation works', true);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no horizontal page scroll at phone width', !overflow);
await page.goto(`${BASE}/`);
await page.getByText('Integration health').waitFor();
await shot('10-mobile');

// 10. Sign out
await page.setViewportSize({ width: 1440, height: 900 });
await page.getByRole('button', { name: 'Account menu' }).click();
await page.getByRole('menuitem', { name: 'Sign out' }).click();
await page.waitForURL(/\/login/);
check('sign out returns to sign-in', true);

check(
  'no console errors',
  consoleErrors.filter((e) => !e.includes('401')).length === 0,
  consoleErrors.slice(0, 3).join(' | '),
);
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
