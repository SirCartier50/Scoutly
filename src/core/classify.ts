import type { ClassifiedPosting, RawPosting } from '@shared/connector'
import type { RoleType } from '@shared/types'

/*
 * Patterns were tuned against ~28,000 live postings from real job boards.
 *
 * The headline finding: broadening the net to catch "Associate" or "Emerging"
 * produces overwhelmingly false hits ("Associate General Counsel", "Emerging
 * Enterprise Account Executive", "Emerging Talent Recruiter" - a recruiter FOR
 * early-career roles, not one of them). So the confident patterns stay narrow,
 * and a deliberately small ambiguous band is handed to Triage instead of being
 * guessed at here.
 */

/** Seniority markers that disqualify a posting outright. */
const SENIOR =
  /\b(senior|sr\.?|staff|principal|lead|distinguished|director|manager|head\s+of|vp|vice\s+president|chief|architect|executive|partner|counsel)\b/i

/**
 * Unambiguous internship signals, including the title variants that actually
 * appear in the wild: "Software Development Intern", "SDE Intern", "Co-op".
 */
const INTERN =
  /\b(intern(ship)?s?|co-?op|summer\s+(analyst|associate|scholar|intern)|winter\s+intern|industrial\s+placement|placement\s+year|praktikum|stage(?:iaire)?|working\s+student|werkstudent)\b/i

/** Unambiguous new-grad signals. */
const NEWGRAD =
  /\b(new\s*grad(uate)?s?|recent\s+graduate|university\s+grad(uate)?|campus\s+hire|graduate\s+(program|programme|scheme|rotation|rotational|engineer|analyst|developer|scientist)|rotational\s+(program|programme)|entry[\s-]level|early[\s-]career|grad\s+(program|scheme))\b/i

/** Structured early-career programs: fellowships, residencies, apprenticeships. */
const PROGRAM =
  /\b(fellowship|apprentice(ship)?s?|residency|scholars?\s+program|scholarship|trainee\s+program|academy\s+program|returnship)\b/i

/**
 * The narrow ambiguous band. Genuinely uncertain from the title alone
 * ("Data Scientist, Core Data - PhD (2026)" is early-career; "PhD Research
 * Scientist" usually is not), so these go to Triage rather than being guessed.
 */
const AMBIGUOUS =
  /\b(phd|ms\/phd|masters?\s+student|university|student|graduate|nucleus|pathways|launchpad|jumpstart|emerging\s+talent|future\s+(leaders?|talent))\b/i

/** A bare year tag often marks a class-year cohort role, e.g. "[Summer 2027]". */
const YEAR_TAG = /\b(20\d{2})\b/

/** Contexts where "fellow"/"resident" is a senior title, not a program. */
const FALSE_PROGRAM =
  /\b(research\s+fellow|senior\s+fellow|fellow\s+engineer|resident\s+(engineer|architect|solutions))\b/i

/**
 * Roles that WORK ON early-career hiring rather than being early-career roles.
 * "Technical Recruiter, Early Career" and "Coordinator, Emerging Talent
 * Recruiting" both match the new-grad vocabulary while being full-time staff
 * jobs. An actual "Recruiting Intern" still classifies as an internship,
 * because the intern check runs before this one.
 */
const RECRUITING =
  /\b(recruit(er|ing|ment)|sourcer|talent\s+(acquisition|partner|coordinator)|people\s+(ops|operations)|hr\s+business\s+partner)\b/i

export interface Classification {
  roleType: RoleType
  needsTriage: boolean
  reason: string
}

/**
 * Classifies from the title, consulting the description only to break a tie.
 * Titles are what feeds reliably provide; descriptions are long and noisy, and
 * matching "intern" anywhere in a description produces constant false hits
 * (e.g. "work with our intern cohort").
 */
export function classify(title: string, description?: string | null): Classification {
  const t = title.trim()

  if (INTERN.test(t)) {
    // "Intern Manager" / "Senior Intern Program Lead" are staff roles.
    if (SENIOR.test(t)) return { roleType: 'other', needsTriage: false, reason: 'intern-word but senior title' }
    return { roleType: 'intern', needsTriage: false, reason: 'intern pattern' }
  }

  if (PROGRAM.test(t) && !FALSE_PROGRAM.test(t)) {
    if (SENIOR.test(t)) return { roleType: 'other', needsTriage: false, reason: 'program-word but senior title' }
    if (RECRUITING.test(t)) return { roleType: 'other', needsTriage: false, reason: 'staff role in early-career recruiting' }
    return { roleType: 'program', needsTriage: false, reason: 'program pattern' }
  }

  if (NEWGRAD.test(t)) {
    if (SENIOR.test(t)) return { roleType: 'other', needsTriage: false, reason: 'newgrad-word but senior title' }
    if (RECRUITING.test(t)) return { roleType: 'other', needsTriage: false, reason: 'staff role in early-career recruiting' }
    return { roleType: 'newgrad', needsTriage: false, reason: 'new-grad pattern' }
  }

  // Ambiguous band: never guessed here, deferred to Triage. Recruiting roles are
  // excluded so we don't pay for a model call to rule out an obvious staff job.
  if (
    !SENIOR.test(t) &&
    !RECRUITING.test(t) &&
    (AMBIGUOUS.test(t) || (YEAR_TAG.test(t) && /\b(engineer|scientist|analyst|developer|research)\b/i.test(t)))
  ) {
    return { roleType: 'other', needsTriage: true, reason: 'ambiguous title, needs triage' }
  }

  // Last resort: an explicit description statement, kept deliberately strict.
  if (description) {
    const d = description.slice(0, 4000)
    if (/\b(this|the)\s+internship\b|\bthis\s+is\s+an?\s+internship\b/i.test(d)) {
      return { roleType: 'intern', needsTriage: false, reason: 'description states internship' }
    }
  }

  return { roleType: 'other', needsTriage: false, reason: 'no early-career signal' }
}

/* --------------------------------------------------------------- function */

export type JobFunction = 'engineering' | 'data' | 'product' | 'design' | 'business' | 'other'

/**
 * Engineering vocabulary, deliberately covering the synonym spread that job
 * boards actually use. "Software Development Intern", "SDE Intern", "Programmer
 * Analyst" and "Software Engineer Intern" are the same role wearing four names,
 * and matching only "software engineer" silently drops three of them.
 */
const ENGINEERING =
  /\b(software|swe\b|sde\b|sdet\b|engineer(ing)?|developer|development|programmer|coding|backend|back[\s-]end|frontend|front[\s-]end|full[\s-]?stack|devops|sre\b|site\s+reliability|infrastructure|platform|systems?|embedded|firmware|hardware|silicon|asic|fpga|compiler|kernel|distributed|cloud|security|cryptography|appsec|network(ing)?|mobile|ios\b|android|web\s+dev|qa\b|quality\s+assurance|test\s+engineer|automation|robotics|computer\s+vision|machine\s+learning|\bml\b|\bai\b|deep\s+learning|nlp\b|research\s+engineer|data\s+engineer|database)\b/i

/** Technical-but-not-software roles the user still likely wants. */
const DATA_FN = /\b(data\s+(scientist|science|analyst|engineer)|analytics|quantitative|statistician|machine\s+learning|\bml\b)\b/i

// Trailing \b would fail on "Product Management" (the boundary lands mid-word),
// so the suffixes are matched explicitly.
const PRODUCT_FN =
  /\b(product\s+manag(er|ers|ement)|product\s+owner|\bpm\b|program\s+manag(er|ers|ement)|technical\s+program)\b/i
const DESIGN_FN = /\b(designer|design\b|\bux\b|\bui\b|user\s+experience|user\s+research|brand|creative|motion\s+graphics)\b/i

/** Non-technical functions that dominate the false positives. */
const BUSINESS_FN =
  /\b(sales|account\s+(executive|manager)|business\s+development|\bbd\b|marketing|growth\s+marketing|content|social\s+media|communications|\bpr\b|finance|accounting|controller|treasury|audit|tax|legal|counsel|paralegal|compliance\s+analyst|human\s+resources|\bhr\b|people\s+ops|recruit(er|ing)|customer\s+(success|support|experience)|support\s+specialist|operations\s+(associate|specialist|coordinator)|supply\s+chain|procurement|facilities|administrative|executive\s+assistant|office\s+manager|community\s+manager|partnerships)\b/i

/**
 * Business vocabulary wins ties: "Sales Engineer" and "Solutions Engineer" are
 * customer-facing revenue roles, not software engineering, and they are common
 * enough to matter.
 */
const SALES_ENGINEER = /\b(sales|solutions|customer|field|partner|pre[\s-]?sales)\s+engineer/i

export function detectFunction(title: string): JobFunction {
  const t = title.trim()

  if (SALES_ENGINEER.test(t)) return 'business'
  if (BUSINESS_FN.test(t)) return 'business'
  if (ENGINEERING.test(t)) return 'engineering'
  if (DATA_FN.test(t)) return 'data'
  if (PRODUCT_FN.test(t)) return 'product'
  if (DESIGN_FN.test(t)) return 'design'
  return 'other'
}

/* ----------------------------------------------------------------- degree */

export type DegreeLevel = 'bachelors' | 'masters' | 'phd'

const DEGREE_RANK: Record<DegreeLevel, number> = { bachelors: 1, masters: 2, phd: 3 }

const PHD_RE = /\b(ph\.?\s?d\.?|doctoral|doctorate)\b/i
const MASTERS_RE = /\b(master'?s?|m\.?s\.?c?\.?\s+(student|degree|candidate)|msc\b|m\.eng\b)\b/i
const BACHELORS_RE = /\b(bachelor'?s?|b\.?s\.?\s+(degree|student)|undergrad(uate)?|b\.?tech\b)\b/i

/**
 * The highest degree a posting appears to REQUIRE, or null when unstated.
 *
 * Deliberately conservative: an unstated requirement returns null and passes
 * every filter, because guessing "PhD required" from an ambiguous phrase would
 * hide roles the user is eligible for. "MS/PhD" and "BS/MS" express a range -
 * the LOWEST level in the range is what actually gates eligibility.
 */
export function degreeRequirement(title: string, description?: string | null): DegreeLevel | null {
  const hay = `${title}\n${(description ?? '').slice(0, 3000)}`

  // A range like "MS/PhD" or "BS, MS, or PhD" means the lowest listed qualifies.
  if (/\b(bs|b\.s\.|ba|bachelor'?s?)\s*[/,]?\s*(or\s+)?(ms|m\.s\.|master'?s?)\b/i.test(hay)) return 'bachelors'
  if (/\b(ms|m\.s\.|master'?s?)\s*[/,]?\s*(or\s+)?(ph\.?d\.?)\b/i.test(hay)) return 'masters'

  const phd = PHD_RE.test(hay)
  const ms = MASTERS_RE.test(hay)
  const bs = BACHELORS_RE.test(hay)

  if (bs) return 'bachelors'
  if (ms) return 'masters'
  if (phd) return 'phd'
  return null
}

/** True when a posting's stated requirement is within the user's level. */
export function degreeAllowed(
  requirement: DegreeLevel | null,
  userMax: DegreeLevel | null
): boolean {
  if (requirement === null) return true // unstated never excludes
  if (userMax === null) return true // no preference set
  return DEGREE_RANK[requirement] <= DEGREE_RANK[userMax]
}

/* --------------------------------------------------------------- location */

const REMOTE = /\b(remote|anywhere|distributed|work\s+from\s+home|wfh|virtual)\b/i

/**
 * Job boards almost never spell out "United States" in a location field - they
 * say "New York, NY" or "San Francisco, CA". A plain substring match against
 * "United States" therefore matches almost nothing, which is exactly the bug
 * that made every US posting look filtered out and every connector look
 * "broken" when the feeds were fine. Country-level aliases get their own
 * recognizer instead of a literal substring test.
 */
const US_ALIASES = new Set(['united states', 'usa', 'u.s.a', 'u.s.a.', 'u.s', 'u.s.', 'us'])

const US_STATE_ABBR = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia',
  'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt',
  'va', 'wa', 'wv', 'wi', 'wy', 'dc'
])

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
  'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
  'wisconsin', 'wyoming', 'district of columbia'
]

/** Recognizes a US location from country name, "City, ST" shape, or state name. */
export function isUnitedStatesLocation(location: string): boolean {
  const loc = location.toLowerCase()
  if (/\b(united states|usa|u\.s\.a?\.?)\b/.test(loc)) return true

  const m = /,\s*([a-z]{2})\b/i.exec(loc)
  if (m?.[1] && US_STATE_ABBR.has(m[1].toLowerCase())) return true

  return US_STATE_NAMES.some((name) => loc.includes(name))
}

/**
 * Substring match against user-supplied locations, which handles the wide
 * variation in how boards format them ("New York, NY", "NYC", "US-NY-New York").
 * Deliberately permissive: a missed location means a missed internship, while a
 * spurious one costs a glance. Country-level US aliases use the recognizer
 * above rather than a literal substring test.
 */
export function matchesLocation(
  location: string | null,
  allowed: string[],
  remoteOk: boolean
): boolean {
  if (allowed.length === 0 && remoteOk) return true

  const loc = (location ?? '').toLowerCase()
  if (remoteOk && REMOTE.test(loc)) return true
  if (allowed.length === 0) return false
  if (!loc) return false

  return allowed.some((a) => {
    const needle = a.trim().toLowerCase()
    if (!needle) return false
    if (US_ALIASES.has(needle)) return isUnitedStatesLocation(loc)
    return loc.includes(needle)
  })
}

/* ---------------------------------------------------------------- filters */

export interface FilterPrefs {
  locations: string[]
  remoteOk: boolean
  wantIntern: boolean
  wantNewGrad: boolean
  wantProgram: boolean
  /** Empty means every function passes. */
  functions?: JobFunction[]
  /** Highest degree the user holds or is pursuing; null means no filter. */
  degreeLevel?: DegreeLevel | null
}

export function classifyPosting(p: RawPosting): ClassifiedPosting {
  const c = classify(p.title, p.description)
  return { ...p, roleType: c.roleType, needsTriage: c.needsTriage }
}

/**
 * Applies role, function, degree and location preferences.
 *
 * Postings flagged `needsTriage` are NOT returned here - they are surfaced
 * separately as "maybe" so an uncertain guess never silently becomes a
 * confident result.
 */
export function applyFilters(
  postings: ClassifiedPosting[],
  prefs: FilterPrefs
): ClassifiedPosting[] {
  const wanted = new Set<RoleType>()
  if (prefs.wantIntern) wanted.add('intern')
  if (prefs.wantNewGrad) wanted.add('newgrad')
  if (prefs.wantProgram) wanted.add('program')

  const fns = prefs.functions ?? []

  return postings.filter((p) => {
    if (!wanted.has(p.roleType)) return false
    if (!matchesLocation(p.location, prefs.locations, prefs.remoteOk)) return false
    if (!functionAllowed(p.title, p.roleType, fns)) return false
    if (!degreeAllowed(degreeRequirement(p.title, p.description), prefs.degreeLevel ?? null)) return false
    return true
  })
}

/**
 * Function filtering EXCLUDES what we're confident is non-technical rather than
 * requiring confident technical detection.
 *
 * Measured on live boards, the strict form dropped "American Tech Fellowship"
 * and Palantir's "Deployment Strategist, Internship" - real technical
 * early-career roles whose titles carry no engineering vocabulary. An unknown
 * function is therefore kept: a missed internship costs far more than a
 * spurious one. Fellowships and programs bypass the filter entirely, since
 * their titles almost never name a function.
 */
export function functionAllowed(
  title: string,
  roleType: RoleType,
  wantedFunctions: JobFunction[]
): boolean {
  if (wantedFunctions.length === 0) return true
  if (roleType === 'program') return true

  const fn = detectFunction(title)
  if (fn === 'other') return true // unknown is not a reason to drop
  return wantedFunctions.includes(fn)
}

/** The ambiguous band, kept separate so the user can review rather than trust. */
export function maybePostings(
  postings: ClassifiedPosting[],
  prefs: FilterPrefs
): ClassifiedPosting[] {
  const fns = prefs.functions ?? []
  return postings.filter((p) => {
    if (!p.needsTriage) return false
    if (!matchesLocation(p.location, prefs.locations, prefs.remoteOk)) return false
    if (!functionAllowed(p.title, p.roleType, fns)) return false
    return true
  })
}
