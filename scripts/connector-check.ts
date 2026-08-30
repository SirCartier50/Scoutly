/**
 * Runs every connector against a real, live job board and checks the shape of
 * what comes back, then exercises the classifier on those real titles.
 *
 * Hits the network deliberately: the whole point is catching the day a feed
 * changes shape, which a mocked test cannot do.
 *
 *   npm run check:connectors
 */
import { fetchCompany } from '../src/core/connectors/index'
import {
  applyFilters, classify, classifyPosting, degreeAllowed, degreeRequirement,
  detectFunction, isUnitedStatesLocation, matchesLocation, maybePostings
} from '../src/core/classify'
import { probe, slugCandidates } from '../src/core/probe'
import type { ConnectorTarget } from '@shared/connector'

let passed = 0
let failed = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`) }
}
const eq = <T,>(label: string, a: T, b: T): void =>
  check(label, Object.is(a, b), `got ${String(a)}, want ${String(b)}`)

const target = (
  o: Partial<ConnectorTarget> & Pick<ConnectorTarget, 'name' | 'atsType'>
): ConnectorTarget => ({
  id: 1, careersUrl: 'https://example.invalid/careers', boardToken: null, parseConfig: null, ...o
})

console.log('\n[classifier — unit]')
eq('plain intern', classify('Software Engineer Intern').roleType, 'intern')
eq('internship suffix', classify('Research Internship, NLP').roleType, 'intern')
eq('year-tagged intern', classify('[Summer 2027] Software Engineer Intern').roleType, 'intern')
eq('co-op', classify('Engineering Co-op (Fall)').roleType, 'intern')
eq('summer analyst', classify('Summer Analyst Program').roleType, 'intern')
eq('new grad', classify('Software Engineer, New Grad').roleType, 'newgrad')
eq('university graduate', classify('University Graduate Engineer').roleType, 'newgrad')
eq('early career', classify('Early Career Software Engineer').roleType, 'newgrad')
eq('rotational', classify('Graduate Rotational Program').roleType, 'newgrad')
eq('fellowship', classify('AI Safety Fellowship').roleType, 'program')
eq('apprenticeship', classify('Software Apprenticeship').roleType, 'program')
eq('residency', classify('ML Residency').roleType, 'program')

console.log('\n[classifier — false positives it must reject]')
eq('senior engineer', classify('Senior Software Engineer').roleType, 'other')
eq('associate counsel', classify('Associate General Counsel, Privacy').roleType, 'other')
eq('emerging enterprise AE', classify('Account Executive, Emerging Enterprise').roleType, 'other')
eq('customer success associate', classify('Customer Success Associate').roleType, 'other')
eq('intern MANAGER is staff', classify('Internship Program Manager').roleType, 'other')
eq('research fellow is senior', classify('Research Fellow, Robotics').roleType, 'other')
eq('"internal" must not match', classify('Internal Tools Engineer').roleType, 'other')
eq('staff engineer', classify('Staff Machine Learning Engineer').roleType, 'other')
eq('early-career RECRUITER is staff', classify('Technical Recruiter, Early Career').roleType, 'other')
eq('emerging talent recruiting coord', classify('Coordinator, Emerging Talent Recruiting').roleType, 'other')
eq('university recruiter is staff', classify('University Recruiting Program Manager').roleType, 'other')
eq('but a Recruiting Intern IS an intern', classify('Recruiting Intern').roleType, 'intern')

console.log('\n[classifier — ambiguous band goes to triage]')
check('PhD year-tagged flagged', classify('Data Scientist, Core Data - PhD (2026)').needsTriage)
check('Nucleus flagged', classify('Nucleus Program').needsTriage)
check('"Pathways" flagged', classify('Pathways Engineer').needsTriage)
check('plain senior NOT flagged', !classify('Senior Data Scientist').needsTriage)
check('plain intern NOT flagged', !classify('SWE Intern').needsTriage)

console.log('\n[location matching]')
check('no filter passes all', matchesLocation('Reykjavik', [], true))
check('substring match', matchesLocation('New York, NY', ['new york'], false))
check('remote honoured', matchesLocation('Remote - US', [], true))
check('remote rejected when off', !matchesLocation('Remote - US', ['boston'], false))
check('non-match rejected', !matchesLocation('Berlin, Germany', ['new york'], false))
check('null location rejected when filtering', !matchesLocation(null, ['nyc'], false))

console.log('\n[location matching — "United States" as a filter]')
// This was the live bug: job boards say "New York, NY", never "United States",
// so a plain substring match against "United States" rejected almost every US
// posting and made every connector look broken.
check('City, ST format recognized as US', isUnitedStatesLocation('Washington, D.C.'))
check('City, CA recognized as US', isUnitedStatesLocation('San Francisco, CA'))
check('full state name recognized', isUnitedStatesLocation('Austin, Texas'))
check('literal country name still works', isUnitedStatesLocation('Remote, United States'))
check('foreign city correctly rejected', !isUnitedStatesLocation('Paris, France'))
check('foreign city correctly rejected 2', !isUnitedStatesLocation('Seoul, South Korea'))
check(
  '"United States" filter now matches "City, ST" postings',
  matchesLocation('Washington, D.C.', ['United States'], true)
)
check(
  '"United States" filter still rejects foreign postings',
  !matchesLocation('Paris, France', ['United States'], true)
)

console.log('\n[filters]')
const sample = [
  classifyPosting({ externalId: '1', title: 'SWE Intern', location: 'New York, NY', applyUrl: 'u', postedAt: null, description: null, department: null }),
  classifyPosting({ externalId: '2', title: 'Senior SWE', location: 'New York, NY', applyUrl: 'u', postedAt: null, description: null, department: null }),
  classifyPosting({ externalId: '3', title: 'SWE Intern', location: 'Berlin', applyUrl: 'u', postedAt: null, description: null, department: null })
]
const filtered = applyFilters(sample, { locations: ['new york'], remoteOk: true, wantIntern: true, wantNewGrad: false, wantProgram: false })
eq('role + location filter', filtered.length, 1)
eq('kept the right one', filtered[0]?.externalId, '1')

console.log('\n[probe — slug generation]')
check('generates slugs', slugCandidates('Scale AI').includes('scaleai'))
check('includes dashed form', slugCandidates('Warby Parker').includes('warby-parker'))

console.log('\n[function detection — title synonyms]')
// The same job wears many names; matching only "software engineer" drops most.
for (const t of [
  'Software Engineer Intern',
  'Software Development Intern',
  'SDE Intern',
  'Software Developer Intern',
  'Programmer Analyst Intern',
  'Backend Engineer Intern',
  'Full Stack Developer Intern',
  'Site Reliability Engineer Intern',
  'Embedded Firmware Intern',
  'Security Engineering Intern',
  'Machine Learning Engineer Intern'
]) {
  eq(`"${t}" -> engineering`, detectFunction(t), 'engineering')
}

console.log('\n[function detection — must NOT be engineering]')
eq('Sales Engineer is business', detectFunction('Sales Engineer Intern'), 'business')
eq('Solutions Engineer is business', detectFunction('Solutions Engineer, Intern'), 'business')
eq('Marketing intern is business', detectFunction('Marketing Intern'), 'business')
eq('Finance intern is business', detectFunction('Finance Intern'), 'business')
eq('Recruiting intern is business', detectFunction('Recruiting Intern'), 'business')
eq('Customer Success is business', detectFunction('Customer Success Intern'), 'business')
eq('Product Manager is product', detectFunction('Product Management Intern'), 'product')
eq('UX designer is design', detectFunction('UX Design Intern'), 'design')

console.log('\n[degree requirement]')
eq('PhD in title', degreeRequirement('Research Scientist Intern, PhD'), 'phd')
eq('Masters in title', degreeRequirement("Master's Student Intern"), 'masters')
eq('Bachelors in title', degreeRequirement("Bachelor's Degree Intern"), 'bachelors')
eq('unstated is null', degreeRequirement('Software Engineer Intern'), null)
// A range is gated by its LOWEST level, not its highest.
eq('MS/PhD range -> masters', degreeRequirement('Research Intern (MS/PhD)'), 'masters')
eq('BS/MS range -> bachelors', degreeRequirement('SWE Intern, BS/MS'), 'bachelors')

console.log('\n[degree eligibility]')
check('unstated passes any level', degreeAllowed(null, 'bachelors'))
check('no preference passes anything', degreeAllowed('phd', null))
check('bachelor can take bachelor roles', degreeAllowed('bachelors', 'bachelors'))
check('bachelor CANNOT take phd-only roles', !degreeAllowed('phd', 'bachelors'))
check('phd can take bachelor roles', degreeAllowed('bachelors', 'phd'))
check('masters can take masters roles', degreeAllowed('masters', 'masters'))
check('masters cannot take phd roles', !degreeAllowed('phd', 'masters'))

console.log('\n[filters — function + degree]')
{
  const mk = (title: string, desc: string | null = null): ReturnType<typeof classifyPosting> =>
    classifyPosting({
      externalId: title, title, location: 'Remote', applyUrl: 'https://x.invalid',
      postedAt: null, description: desc, department: null
    })

  const set = [
    mk('Software Development Intern'),
    mk('Marketing Intern'),
    mk('Sales Engineer Intern'),
    mk('Research Intern, PhD'),
    mk('Data Scientist, Core Data - PhD (2026)')
  ]

  const engOnly = applyFilters(set, {
    locations: [], remoteOk: true, wantIntern: true, wantNewGrad: true, wantProgram: true,
    functions: ['engineering', 'data']
  })
  check('engineering filter keeps the SWE intern', engOnly.some((p) => p.title === 'Software Development Intern'))
  check('engineering filter drops marketing', !engOnly.some((p) => p.title === 'Marketing Intern'))
  check('engineering filter drops sales engineer', !engOnly.some((p) => p.title === 'Sales Engineer Intern'))

  // Unknown-function titles must survive: a fellowship or an oddly-named
  // technical role is exactly what this app exists to catch.
  const odd = [
    mk('American Tech Fellowship'),
    mk('Deployment Strategist, Internship'),
    mk('Nucleus Intern')
  ]
  const kept = applyFilters(odd, {
    locations: [], remoteOk: true, wantIntern: true, wantNewGrad: true, wantProgram: true,
    functions: ['engineering', 'data']
  })
  check('fellowship survives the engineering filter', kept.some((p) => p.title === 'American Tech Fellowship'))
  check('unknown-function internship survives', kept.some((p) => p.title === 'Deployment Strategist, Internship'))

  const bachelorOnly = applyFilters(set, {
    locations: [], remoteOk: true, wantIntern: true, wantNewGrad: true, wantProgram: true,
    degreeLevel: 'bachelors'
  })
  check('bachelor filter drops the PhD role', !bachelorOnly.some((p) => p.title === 'Research Intern, PhD'))
  check('bachelor filter keeps unstated roles', bachelorOnly.some((p) => p.title === 'Software Development Intern'))

  const maybes = maybePostings(set, {
    locations: [], remoteOk: true, wantIntern: true, wantNewGrad: true, wantProgram: true
  })
  check('ambiguous PhD-2026 role lands in Maybe', maybes.some((p) => p.title.includes('Core Data')))
  check('confident roles do not land in Maybe', !maybes.some((p) => p.title === 'Software Development Intern'))
}

/* ---------------------------------------------------------- live connectors */

interface LiveCase { name: string; ats: 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters'; token: string }
const LIVE: LiveCase[] = [
  { name: 'Figma', ats: 'greenhouse', token: 'figma' },
  { name: 'Palantir', ats: 'lever', token: 'palantir' },
  { name: 'Notion', ats: 'ashby', token: 'notion' },
  { name: 'Glean', ats: 'smartrecruiters', token: 'glean' }
]

console.log('\n[connectors — live network]')
for (const c of LIVE) {
  const res = await fetchCompany(target({ name: c.name, atsType: c.ats, boardToken: c.token }))
  check(`${c.ats}: fetch succeeded`, res.ok, res.error)
  if (!res.ok) continue

  const ps = res.postings
  check(`${c.ats}: returned postings (${ps.length})`, ps.length > 0)
  check(`${c.ats}: every posting has an id`, ps.every((p) => !!p.externalId))
  check(`${c.ats}: every posting has a title`, ps.every((p) => !!p.title))
  check(`${c.ats}: every applyUrl is absolute http(s)`, ps.every((p) => /^https?:\/\//.test(p.applyUrl)))
  check(`${c.ats}: external ids are unique`, new Set(ps.map((p) => p.externalId)).size === ps.length)

  const classified = ps.map(classifyPosting)
  const early = classified.filter((p) => p.roleType !== 'other')
  const triage = classified.filter((p) => p.needsTriage)
  console.log(
    `        ${c.name}: ${ps.length} jobs, ${early.length} early-career ` +
    `(${early.filter((p) => p.roleType === 'intern').length} intern), ${triage.length} need triage`
  )
  for (const e of early.slice(0, 3)) console.log(`          - [${e.roleType}] ${e.title}`)
}

console.log('\n[dedicated connectors — live network]')
// Reverse-engineered from each company's OWN site's real network traffic, not
// guessed. Amazon needs a two-step session-cookie handshake; Microsoft needs
// no auth at all. Both were found missing entirely from the free-probe-only
// directory, which is why they get dedicated connectors instead of relying on
// a public ATS platform that these companies don't use.
for (const c of [
  { name: 'Amazon', ats: 'amazonjobs' as const },
  { name: 'Microsoft', ats: 'microsoftjobs' as const },
  { name: 'Google', ats: 'googlejobs' as const },
  { name: 'Apple', ats: 'applejobs' as const }
]) {
  const res = await fetchCompany(target({ name: c.name, atsType: c.ats, boardToken: null }))
  check(`${c.name}: fetch succeeded`, res.ok, res.error)
  if (!res.ok) continue

  const ps = res.postings
  check(`${c.name}: returned postings (${ps.length})`, ps.length > 0)
  check(`${c.name}: every posting has a title`, ps.every((p) => !!p.title))
  check(`${c.name}: every applyUrl is absolute http(s)`, ps.every((p) => /^https?:\/\//.test(p.applyUrl)))
  check(`${c.name}: external ids are unique`, new Set(ps.map((p) => p.externalId)).size === ps.length)

  const early = ps.map(classifyPosting).filter((p) => p.roleType !== 'other')
  console.log(`        ${c.name}: ${ps.length} jobs, ${early.length} early-career`)
  for (const e of early.slice(0, 3)) console.log(`          - [${e.roleType}] ${e.title}`)

  // Regression: Amazon's createdDate is Unix SECONDS, not milliseconds. Fed
  // straight into `new Date()` this silently produced a January-1970 postedAt
  // on every posting, which the age-cutoff feature then (correctly, given the
  // bad input) auto-closed as ancient. This checks for that specific failure
  // mode (epoch-adjacent dates) rather than "recent" - some companies (Amazon's
  // rolling "Talent Pool" postings among them) legitimately keep a req open and
  // dated over a year out; that's real data the user's own age-cutoff setting
  // decides on, not a connector bug.
  const epochEra = new Date('2000-01-01')
  const withDates = ps.filter((p) => p.postedAt !== null)
  check(
    `${c.name}: postedAt values are not epoch-garbage (e.g. Jan 1970)`,
    withDates.every((p) => new Date(p.postedAt as string) > epochEra),
    withDates.find((p) => new Date(p.postedAt as string) <= epochEra)?.postedAt ?? undefined
  )

  // Regression: Apple's location objects separate city from country
  // (name:"Austin", countryName:"United States of America"). Joining as
  // `name || countryName` silently dropped the country whenever a city was
  // present - "Austin" alone has no recognizable-US evidence, so the
  // "United States" location filter correctly-per-that-bug excluded every US
  // posting that only listed a city. The real fix always concatenates
  // name/city with countryName, so every non-empty location should now
  // contain the ", " separator - a bare single word means the country got
  // dropped again.
  if (c.name === 'Apple') {
    const withLocation = ps.filter((p) => p.location !== null && p.location.trim() !== '')
    check(
      `${c.name}: locations include their country, not just a bare city`,
      withLocation.every((p) => (p.location as string).includes(',')),
      withLocation.find((p) => !(p.location as string).includes(','))?.location ?? undefined
    )
  }
}

console.log('\n[probe — live discovery]')
const p1 = await probe('Figma', 'https://job-boards.greenhouse.io/figma')
check('probe resolves Figma', p1?.atsType === 'greenhouse' && p1.boardToken === 'figma', JSON.stringify(p1))
const p2 = await probe('Notion', null)
check('probe resolves Notion by slug alone', p2?.atsType === 'ashby', JSON.stringify(p2))
const p3 = await probe('Zzzznotarealcompany', null)
check('probe returns null for nonsense', p3 === null, JSON.stringify(p3))

console.log('\n[error handling]')
const bad = await fetchCompany(target({ name: 'Nope', atsType: 'greenhouse', boardToken: 'definitely-not-a-real-board-xyz' }))
check('bad token fails cleanly', !bad.ok && bad.postings.length === 0)
check('bad token is not marked transient', bad.transient === false, `transient=${bad.transient}`)
const noConn = await fetchCompany(target({ name: 'Nope', atsType: 'unknown' }))
check('unknown ats fails cleanly', !noConn.ok)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
