// PRIESTATE — Disposable/throwaway email-domain rejection (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Registration email verification rejects one-time / throwaway mailboxes so
// an identity cannot be registered against an untraceable address. The check
// runs on the SERVER (never in the browser) against a curated blocklist of
// well-known disposable domains plus any configured extras
// (DISPOSABLE_EMAIL_BLOCK_LIST). Matching is done on the normalized domain so
// subdomains and "cosmetic" rewrites do not silently bypass it. Configured
// extras can be appended with `DISPOSABLE_EMAIL_BLOCK_LIST`, e.g.
// "example.com, other.tld".

export interface DisposableEmailOptions {
  /** Extra domains (lowercase, no leading dot) to block. */
  readonly extraDomains?: readonly string[];
  readonly enabled?: boolean;
}

/** Well-known disposable / throwaway mailbox domains (curated). */
export const DISPOSABLE_DOMAINS: readonly string[] = [
  '0-mail.com',
  '027168.com',
  '0815.ru',
  '0clickemail.com',
  '10minutemail.com',
  '20minutemail.com',
  '24hourmail.com',
  '33mail.com',
  '3d-painting.com',
  '4warding.net',
  '5ymail.com',
  '6mail.cf',
  'anonaddy.com',
  'anonymbox.com',
  'antispam24.de',
  'armyspy.com',
  'artman-conception.com',
  'avastrc.com',
  'b.crazysexycool.com',
  'battricks.com',
  'bearsarefuzzy.com',
  'bestchoiceusedcar.com',
  'bigprofessor.so',
  'bio-muesli.net',
  'biscutt.com',
  'biz.st',
  'bluebottle.com',
  'bofthew.com',
  'brefmail.com',
  'bronxriver.com',
  'bugmenot.com',
  'bumpylife.com',
  'buyusedlibrarybooks.org',
  'c2xi.com',
  'cachedot.net',
  'cellurl.com',
  'centermail.net',
  'cneemail.com',
  'cock.li',
  'courriel.fr.nf',
  'courrieltemporaire.com',
  'crapmail.org',
  'crazymailing.com',
  'curryworld.de',
  'dab.ro',
  'deadaddress.com',
  'discard.email',
  'dispose.it',
  'disposemail.com',
  'dodgeit.com',
  'dodgit.com',
  'dodsi.com',
  'dontmail.net',
  'drivetagdev.com',
  'dump-email.info',
  'e4ward.com',
  'email-fake.com',
  'emailigo.de',
  'emailias.com',
  'emailnator.com',
  'emailondeck.com',
  'emailproxsy.com',
  'emailsensei.com',
  'emailtemporario.com.br',
  'emailtex.com',
  'emz.net',
  'ephemail.net',
  'explodemail.com',
  'fakemail.net',
  'fakeinbox.com',
  'fammail.com',
  'fastag.com',
  'fdfdsfds.com',
  'filzmail.com',
  'fizmail.com',
  'fr33mail.info',
  'frapmail.com',
  'fuckingduh.com',
  'fudgerub.com',
  'garliclife.com',
  'getairmail.com',
  'getnada.com',
  'ghosttexter.de',
  'girlsundertheinfluence.com',
  'grandmamail.com',
  'grr.la',
  'guerrillamail.com',
  'haltospam.com',
  'harakirimail.com',
  'hat-gmail.de',
  'headermail.de',
  'hotpop.com',
  'hula22.de',
  'hixteam.ru',
  'icx.in',
  'incognitomail.com',
  'inboxbear.com',
  'inboxstore.me',
  'inbounce.me',
  'inpwa.my.id',
  'is.af',
  'jetable.org',
  'junk1e.com',
  'kamsg.com',
  'kasmail.com',
  'kcrw.de',
  'keepmymail.com',
  'killmail.com',
  'kochoe.com',
  'kulturbetrieb.info',
  'kusma.eu',
  'lak.pp.ua',
  'lazyinbox.com',
  'leeching.net',
  'limitedmail.net',
  'litedrop.com',
  'lolfml.com',
  'mail-temporaire.fr',
  'mail0.ga',
  'maildrop.cc',
  'maileater.com',
  'mailexpire.com',
  'mailforspam.com',
  'mailinator.com',
  'mailmetrash.com',
  'mailnator.com',
  'mailnesia.com',
  'mailnull.com',
  'mailo.com',
  'mailpick.biz',
  'mailsac.com',
  'mailtemp.net',
  'mailtothis.com',
  'mailzilla.org',
  'mcid.me',
  'meltmail.com',
  'mintemail.com',
  'moburl.com',
  'moncourrier.fr.nf',
  'moneypipe.net',
  'mrmail.info',
  'msgos.com',
  'mt2009.com',
  'mx0.wwwnew.eu',
  'my10minutemail.com',
  'mycard.net.za',
  'mytrashmail.com',
  'negated.com',
  'neverbox.com',
  'nincsmail.com',
  'nobulk.com',
  'nobox.org',
  'nospam.ze.tc',
  'nowmymail.com',
  'obobbo.com',
  'oneoffemail.com',
  'onewaymail.com',
  'online-ebook.info',
  'oopi.org',
  'ordinaryamerican.net',
  'ourklips.com',
  'outlawspam.com',
  'owlymail.com',
  'pizzajunkmail.com',
  'poofy.org',
  'pookmail.com',
  'privacy.net',
  'proxyemail.net',
  'punkass.com',
  'putthisinyourspamdatabase.com',
  'quickinbox.com',
  'rcpt.at',
  'recode.me',
  'recursor.net',
  'reg.mk',
  'rejectmail.com',
  'rhyta.com',
  'rmqkr.net',
  'sandelf.de',
  'schachrolf.de',
  'schafmail.de',
  'shiftmail.com',
  'shhmail.com',
  'sibmail.com',
  'skeptimail.com',
  'slickrocket.com',
  'slopsbox.com',
  'smashmail.de',
  'snap-mail.com',
  'snkmail.com',
  'sneakemail.com',
  'sofort-mail.de',
  'spam4.me',
  'spamail.de',
  'spamavert.com',
  'spambox.us',
  'spamday.com',
  'spamex.com',
  'spamfree24.org',
  'spamgourmet.com',
  'spamhole.com',
  'spamkiller.priv.at',
  'spam.la',
  'spamnomore.com',
  'spamslicer.com',
  'spamthisplease.com',
  'speed.1s.fr',
  'spoofmail.de',
  'stopdropandroll.com',
  'suckmypet.com',
  'temporaryforwarding.com',
  'temporaryinbox.com',
  'tempinbox.com',
  'tempmail.org',
  'tempomail.fr',
  'thecloudindex.com',
  'thejoecloud.com',
  'thisisnotmyrealemail.com',
  'throwawayemailaddress.com',
  'tilien.com',
  'tmail.ws',
  'toiea.com',
  'tradermail.info',
  'trashmail.com',
  'trashymail.com',
  'trialmail.de',
  'turual.com',
  'uggsrock.com',
  'undef1nity.me',
  'unmean.com',
  'uymail.com',
  'veryrealemail.com',
  'viditag.com',
  'virtualpobox.com',
  'vomoto.com',
  'vpn-mail.net',
  'waitingforsend.com',
  'webm4il.info',
  'wegwerfmail.de',
  'wegwerpmailadres.nl',
  'wh4f.org',
  'whyspam.me',
  'willselfdestruct.com',
  'whoismail.net',
  'wolfmail.com',
  'wralawfirm.com',
  'x24.com',
  'xoxy.net',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'ypmail.webarnak.fr.eu.org',
  'zehnminutenmail.de',
  'zippymail.info',
  'zoaxe.com',
  'zoetropes.org',
  'zzz.com',
];

export interface DisposableEmailResult {
  readonly blocked: boolean;
  readonly domain: string;
  readonly reason: 'disposable' | 'extra-blocked' | null;
}

export class DisposableEmailChecker {
  private readonly blocked: Set<string>;
  readonly enabled: boolean;

  constructor(options: DisposableEmailOptions = {}) {
    this.enabled = options.enabled ?? true;
    const set = new Set(DISPOSABLE_DOMAINS.map((d) => d.toLowerCase().replace(/^\.+/, '')));
    for (const d of options.extraDomains ?? []) {
      const norm = d.trim().toLowerCase().replace(/^\.+/, '');
      if (norm) set.add(norm);
    }
    this.blocked = set;
  }

  /**
   * Check a (pre-normalized lower-case) email address for a disposable domain.
   * Subdomains resolve to the registrable part (last two labels) for matching.
   */
  check(email: string): DisposableEmailResult {
    const at = email.lastIndexOf('@');
    const domain = at >= 0 ? email.slice(at + 1).toLowerCase() : '';
    if (!this.enabled) return { blocked: false, domain, reason: null };
    const normalized = this.normalizeDomain(domain);
    if (this.blocked.has(normalized)) {
      return { blocked: true, domain, reason: 'disposable' };
    }
    return { blocked: false, domain, reason: null };
  }

  private normalizeDomain(domain: string): string {
    const labels = domain.replace(/\.+$/, '').split('.').filter(Boolean);
    return labels.slice(-2).join('.');
  }
}

/** Build a checker from environment-derived options. */
export function createDisposableEmailChecker(extra?: string | null): DisposableEmailChecker {
  const extraDomains = (extra ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  return new DisposableEmailChecker({ extraDomains });
}