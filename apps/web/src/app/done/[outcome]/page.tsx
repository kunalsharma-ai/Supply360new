import type { Metadata } from 'next';

/** Where respondents land after a survey. Public, no session, nothing tracked beyond the API's redirect record. */
const COPY: Record<string, { title: string; body: string }> = {
  complete: { title: 'Thank you', body: 'Your answers are in. You can close this page.' },
  terminate: {
    title: 'Thank you for your time',
    body: 'This survey was looking for a different group of people. We will invite you to others that fit you better.',
  },
  'quota-full': {
    title: 'This survey is full',
    body: 'Enough people like you have already taken part. Thank you for trying, we will invite you to another one.',
  },
  'quality-fail': { title: 'Thank you', body: 'This survey has ended for you. You can close this page.' },
  duplicate: { title: 'You have already taken part', body: 'Each person can take this survey once. Thank you.' },
  'security-reject': { title: 'This survey has ended', body: 'You can close this page.' },
  partial: { title: 'Thank you', body: 'Your progress has been saved. You can close this page.' },
  'technical-error': {
    title: 'Something went wrong',
    body: 'The survey could not continue because of a technical problem. Sorry about that.',
  },
  // Survey router outcomes (Phase 4).
  closed: {
    title: 'This survey has closed',
    body: 'It is no longer taking part. Thank you for wanting to help; we will invite you to another one.',
  },
  'link-expired': {
    title: 'This link has expired',
    body: 'Invitations work for a limited time. Watch for your next one.',
  },
  invalid: { title: 'This link does not work', body: 'Please open the link exactly as it arrived in your invitation.' },
  'link-check': {
    title: 'Link checked',
    body: 'This link was checked by a security scanner. If you are the person invited, open it from your invitation.',
  },
};
const FALLBACK = { title: 'Thank you', body: 'You can close this page.' };

export const metadata: Metadata = { title: 'Thank you', robots: { index: false, follow: false } };

export default async function Done({ params }: { params: Promise<{ outcome: string }> }) {
  const { outcome } = await params;
  const c = COPY[outcome] ?? FALLBACK;
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4">
      <div className="max-w-md rounded-xl border border-border bg-surface p-8 text-center">
        <h1 className="text-xl font-semibold tracking-tight">{c.title}</h1>
        <p className="mt-2 text-sm text-muted">{c.body}</p>
      </div>
    </main>
  );
}
