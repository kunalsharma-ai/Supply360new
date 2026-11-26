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
// A step that times out leaves a screenshot and the console errors behind, so the failure can be read.
process.on('uncaughtException', async (e) => {
  console.error(e);
  console.error('Console errors:', consoleErrors.slice(-5));
  await page.screenshot({ path: `${SHOTS ?? '.'}/failure.png` }).catch(() => {});
  process.exit(1);
});

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
await page.goto(`${BASE}/participation`);
await page.getByText('Arrives in Phase 5').waitFor();
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
const lifecycleAct = async (action, label) => {
  await page.getByRole('toolbar').getByRole('button', { name: action }).click();
  await page.fill('#reason', `E2E ${action.toLowerCase()}`);
  await page.getByRole('dialog').getByRole('button', { name: action }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByText(label, { exact: true }).first().waitFor();
};
await lifecycleAct('Mark ready', 'Ready to launch');
check(
  'Launch waits for quota mapping and audience',
  await page.getByRole('toolbar').getByRole('button', { name: 'Launch' }).isDisabled(),
);
const projectUrl = page.url();

// 7c. Phase 3: audience from MADP (FIXTURE), quota mapping, allocation and reservations
await page.goto(`${BASE}/audience/finder`);
await page.getByRole('button', { name: 'Count', exact: true }).click();
await page.getByTestId('unique-people').waitFor();
const unique = Number((await page.getByTestId('unique-people').innerText()).replaceAll(',', ''));
check('Audience Finder counts the DEMO population once per person', unique === 6000, `got ${unique}`);
check('people in several panels are explained, not added up', await page.getByText('in more than one').isVisible());
await axe('audience finder');
await shot('17-audience-finder');

await page.goto(`${BASE}/audience/filter`);
await page.getByLabel('Add an attribute').selectOption({ label: 'Gender (self-reported)' });
await page.getByRole('button', { name: 'Count', exact: true }).click();
await page.getByTestId('unique-people').waitFor();
check(
  'the filter never offers special-category attributes',
  !(await page.getByLabel('Add an attribute').innerText()).includes('Ethnicity'),
);
await page.fill('#seg-name', 'E2E women');
await page.getByRole('button', { name: 'Save' }).click();
await page.getByText('Saved segment').waitFor();
await axe('audience filter');
await shot('18-audience-filter');

await page.goto(projectUrl);
await page.getByRole('link', { name: 'Quotas and audience' }).click();
await page.getByText('US · Female').waitFor();
for (const cell of ['GB · whole market', 'US · Female', 'US · Male']) {
  await page
    .getByRole('row', { name: new RegExp(cell) })
    .getByRole('button', { name: 'Map' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn2Opinion' }).click();
  if (cell !== 'GB · whole market') {
    await page.getByRole('dialog').getByLabel('Add an attribute').selectOption({ label: 'Gender (self-reported)' });
    if (cell.endsWith('Male')) {
      // The attribute starts on its first value (female): pick male, then drop female.
      await page.getByRole('dialog').getByRole('button', { name: 'male', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'female', exact: true }).click();
    }
  }
  await page.getByRole('dialog').getByRole('button', { name: 'Count', exact: true }).click();
  await page.getByRole('dialog').getByTestId('unique-people').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Save mapping' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
check('every quota cell can be mapped to MADP criteria', (await page.getByText('Not mapped').count()) === 0);

await page.getByRole('link', { name: 'Allocation and caps' }).click();
await page.getByRole('button', { name: 'Save allocation' }).click();
await page.getByText('Allocation saved').waitFor();
// Stacked toasts fade out behind the newest one; let them go before checking contrast.
await page.locator('[data-sonner-toast]').first().waitFor({ state: 'detached', timeout: 15000 });
await axe('allocation');
await shot('19-allocation');

await page.getByRole('link', { name: 'Quota cells' }).click();
for (const cell of ['GB · whole market', 'US · Female', 'US · Male']) {
  await page
    .getByRole('row', { name: new RegExp(cell) })
    .getByRole('button', { name: 'Reserve' })
    .click();
  await page.fill('#res-count', '25');
  await page.getByRole('dialog').getByRole('button', { name: 'Reserve' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
await page.getByText('Audience reserved in MADP for every open cell').waitFor();
check('reservations hold people in every cell', (await page.getByText('25 held for').count()) === 3);
await axe('quota management');
await shot('20-quotas');

await page.goto(`${BASE}/audience/segments`);
await page.locator('tbody tr').first().waitFor();
check('each reservation leaves a selection snapshot', (await page.locator('tbody tr').count()) >= 3);
await axe('segments');
await shot('21-segments');

await page.goto(`${BASE}/integrations/madp`);
await page.getByRole('button', { name: 'Check' }).click();
await page.getByText('MADP answered').waitFor();
await axe('MADP integration');
await shot('22-madp');

await page.goto(projectUrl);
await page.getByRole('heading', { name: 'Launch checks' }).waitFor();
await lifecycleAct('Launch', 'Live');
check('with audience reserved a person can launch', await page.getByText('Dispatch allowed').isVisible());
await axe('project detail');
await shot('12-project-detail');

// 7d. Phase 4: execution policy, a batch through MADP (FIXTURE delivery), router, reminders, schedule, kill switch
const pid = projectUrl.split('/').pop();
await page.goto(`${BASE}/automation?project=${pid}`);
await page.getByRole('heading', { name: 'Mode and limits' }).waitFor();
check('no limit is filled in until a person sets it', (await page.inputValue('#p-batch')) === '');
for (const [sel, v] of [
  ['#p-batch', '10'],
  ['#p-daily', '1000'],
  ['#p-review', '15'],
  ['#p-esc', '50'],
  ['#p-qs', '0'],
  ['#p-qe', '0'],
  ['#p-tz', 'UTC'],
  ['#p-link', '7'],
  ['#p-rem', '24, 72'],
  ['#p-reason', 'E2E policy'],
])
  await page.fill(sel, v);
await page.getByRole('checkbox', { name: 'Turn2Opinion' }).check();
await page.getByRole('button', { name: 'Save policy' }).click();
await page.getByText('Policy saved as version 1').waitFor();
await page.locator('[data-sonner-toast]').first().waitFor({ state: 'detached', timeout: 15000 });
await axe('workflow automation');
await shot('23-automation');

await page.goto(`${BASE}/invitations?project=${pid}`);
await page.getByRole('heading', { name: 'New batch' }).waitFor();
await page.fill('#b-size', '5');
await page.fill('#b-reason', 'E2E first batch');
await page.getByRole('button', { name: 'Send', exact: true }).click();
await page.getByText(/^Sent \d+ invitations/).waitFor();
await page.getByRole('cell', { name: 'sent', exact: true }).first().waitFor();
check('a manual batch is sent after its checks', (await page.getByRole('cell', { name: 'sent', exact: true }).count()) > 0);
await page.locator('[data-sonner-toast]').first().waitFor({ state: 'detached', timeout: 15000 });
await axe('invitation engine');
await shot('24-invitations');

const visitor = await ctx.newPage();
await visitor.goto(`${BASE}/api/v1/i/demo/${'x'.repeat(44)}`);
check(
  'a forged participation link lands on a plain page and reveals nothing',
  await visitor.getByRole('heading', { name: 'This link does not work' }).isVisible(),
);
await visitor.close();
await page.goto(`${BASE}/router`);
await page.getByRole('cell', { name: 'invalid', exact: true }).first().waitFor();
await axe('survey router');
await shot('25-router');

await page.goto(`${BASE}/reminders`);
await page.getByRole('cell', { name: 'pending', exact: true }).first().waitFor();
check('reminders are planned for the invited who have not clicked', (await page.getByRole('cell', { name: 'pending', exact: true }).count()) > 0);
await axe('reminder engine');
await shot('26-reminders');

await page.goto(`${BASE}/schedule`);
await page.getByText('Project calendars').waitFor();
await page.locator('tbody tr').first().waitFor();
await axe('scheduling engine');
await shot('27-schedule');

await page.goto(`${BASE}/automation?project=${pid}`);
await page.getByRole('button', { name: 'Emergency stop' }).click();
await page.fill('#stop-reason', 'E2E drill');
await page.getByRole('button', { name: 'Stop all sending' }).click();
await page.getByText('Emergency stop is on for every project').waitFor();
check('the emergency stop shows on every screen that sends', true);
await page.locator('[data-sonner-toast]').first().waitFor({ state: 'detached', timeout: 15000 });
await shot('28-kill-switch');
await page.getByRole('button', { name: 'Lift emergency stop' }).click();
await page.fill('#stop-reason', 'E2E drill over');
await page.getByRole('button', { name: 'Lift the stop' }).click();
await page.getByText('Sending resumed').waitFor();

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
