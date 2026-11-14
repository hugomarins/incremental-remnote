# Search Engine

On the desktop, the plugin can search your knowledge base with a query language modelled on [Anki's](https://docs.ankiweb.net/searching.html): every word must match, and you can combine words with `or` and `-`, search under a document, or filter by tag, Rem type, Source, slot or property value. [Find Rem](Utilities-Finding-and-Navigating.md#find-rem-reference-or-open) uses it: a ⚡ in the search box means the search engine answered.

The engine runs in the [AI helper](Desktop-Helpers.md#search) on your computer, reading RemNote's own database without changing it. On the iPhone, on the web, or with the helper off, Find Rem uses RemNote's search as before, and the keys on this page are read as ordinary words.

!!! info "Setting it up"
    1. Run the [AI helper](Desktop-Helpers.md#setup), version 1.0.231 or later, with `rem_search.py` and `rem_index.py` next to it.
    2. Print its pairing token with `python3 ~/.incremental-remnote/ai_ocr_helper.py --pairing-token` and paste it in the plugin settings, **AI Helper Pairing Token** ([why a token](Desktop-Helpers.md#search)).

    The first time you use a key such as `tag:` or `is:`, the helper indexes the knowledge base, which takes about 20 seconds; Find Rem says so and searches the words meanwhile.

## Why it finds more { #why }

RemNote's search, the only one a plugin can call, looks for Rems with **any** of your words, then keeps the first 1,000 by a ranking that ignores what you typed. A Rem holding every word can be cut before it is shown. In one knowledge base, `bow weather wave` matched 5,874 Rems on any word and one Rem on all three; that Rem matched the words better than 5,630 of the others, but sat 2,761st on RemNote's ranking, so it was cut.

<figure>
<svg viewBox="0 0 640 132" role="img" aria-label="The 5,874 Rems with any of the words, drawn to scale. The first 1,000 by RemNote's ranking are kept. The note with all three words is 244th by text match but 2,761st by RemNote's ranking, so it is cut." style="max-width:640px;width:100%">
<style>.se-t{font:13px system-ui,sans-serif;fill:var(--md-default-fg-color,currentColor)}.se-s{font:11px system-ui,sans-serif;fill:var(--md-default-fg-color--light,currentColor)}</style>
<text class="se-t" x="0" y="24">By text match</text>
<rect x="150" y="12" width="480" height="20" rx="3" fill="#8a94a0" opacity=".18"/>
<rect x="150" y="12" width="81.7" height="20" rx="3" fill="#0f8a99" opacity=".35"/>
<circle cx="169.9" cy="22" r="6" fill="#2e9e55"/>
<text class="se-s" x="178" y="48">244th: kept on this measure</text>
<text class="se-t" x="0" y="80">By RemNote's ranking</text>
<rect x="150" y="68" width="480" height="20" rx="3" fill="#8a94a0" opacity=".18"/>
<rect x="150" y="68" width="81.7" height="20" rx="3" fill="#0f8a99" opacity=".35"/>
<circle cx="375.6" cy="78" r="6" fill="#d0453b"/>
<text class="se-s" x="384" y="104">2,761st: cut</text>
<text class="se-s" x="150" y="126">1</text>
<text class="se-s" x="200" y="126">1,000 kept</text>
<text class="se-s" x="596" y="126">5,874</text>
</svg>
<figcaption>The 5,874 Rems with any of the words, to scale. The shaded band is what RemNote keeps.</figcaption>
</figure>

The search engine runs a real search instead: all your words, against RemNote's whole index, in a few milliseconds.

## Simple searches { #simple }

`bow weather`
:   finds Rems with both words. Each word matches from its start: `bow` also finds *bowsprit*, not *elbow*.

`bow and weather`
:   the same; `and` is optional.

`bow or bowsprit`
:   finds Rems with either word.

`bow (wave or sea)`
:   finds Rems with `bow` and `wave`, or `bow` and `sea`.

`-tug`
:   finds Rems without `tug`. `bow -tug -pilot` excludes both.

`-(tug or pilot)`
:   the same as `-tug -pilot`.

`"bow flare"`
:   finds the two words side by side.

`w:bow`
:   finds the whole word `bow` only: not *bowsprit*.

`under-keel`, `6.4`
:   words joined by punctuation are searched side by side: `under-keel` finds *under keel clearance*.

Things to note:

- Words are separated by spaces, and all of them must match. `and` binds tighter than `or`: `dog cat or mouse` is `(dog cat) or mouse`, as in Anki.
- **Accents and capitals never matter**: `navegacao` finds *Navegação*. Anki needs `nc:` for this; here it is always on.
- **Clozes don't get in the way**: cloze markup isn't in the index, so clozed words are searched like any other (Anki needs `sc:`).
- A **reference** in a Rem is searched by the name it shows, but RemNote's index keeps it at the end of the Rem's text: `sea margin becomes` finds *"[sea margin] becomes useless…"*, while the phrase `"sea margin becomes"` doesn't.
- Text in a Rem's back (the answer side) is searched too.

## Where to search { #where }

`in:"Wärtsilä Encyclopedia of Ship Technology"`
:   searches the document and everything under it. Quotes are needed when a name has spaces.

`in:*miguens* radar`
:   `*` matches part of a name: `radar` under every **document or folder** whose name contains *miguens*. When no document or folder matches, any Rem with that name does (up to 200).

`in:63ZzPW7lNc3ceJWVy`
:   a Rem id works too.

`squat -in:Archive`
:   leaves out everything under *Archive*.

`parent:"Bow flare"`
:   only the direct children of *Bow flare*.

`path:pscpp squat`
:   `squat` in Rems with *pscpp* in the name of any Rem above them.

A name shared by several Rems covers all of them. A name that matches nothing says so under the box, and suggests a `*`.

## Tags, kinds and powerups { #tags }

`tag:"Anki Card - Standard Mono"`
:   Rems with that tag. RemNote shows powerups as tags, so `tag:Incremental` finds IncRems too.

`tag:anki*`
:   Rems with a tag whose name starts with *anki*.

`tag:none`
:   Rems with no tag.

`is:concept`, `is:descriptor`, `is:portal`
:   Rems of that type.

`is:document`, `is:folder`
:   documents and folders.

`is:flashcard`, `is:image`, `is:pdf`, `is:website`
:   Rems with flashcards, images, uploaded PDFs, web pages.

`is:incremental`, `is:dismissed`
:   IncRems, and Rems you dismissed.

`is:pdf-highlight`, `is:html-highlight`, `is:web-highlight`
:   highlights.

`has:tag`, `has:alias`, `has:source`
:   Rems with a tag, an alias, a Source.

`has:powerup:Video`
:   Rems with that powerup, by name or code.

## Sources and references { #sources }

`source:"PDF Carlton Marine Propellers and Propulsion, 4e"`
:   Rems with that Rem among their **Sources**.

`source:*M23*`
:   Rems whose Sources include any Rem named with *M23*. The name is matched only among Rems that are someone's Source, so it is quick.

`refs:"Service power margin"`
:   Rems whose text references *Service power margin*: its backlinks. `refs:*margin*` works the same way.

`alias:"sea margin"`
:   Rems found through one of their aliases.

`id:go7LdXuu9hpAZH12G,rzGXXDY2z0yi0Iefg`
:   these Rems.

## Slots and properties { #properties }

Every powerup slot and every property of a tag can be searched, like Anki's fields. Write the owner and the name, separated by a dot: the owner is the powerup (its name or code) or the tag that has the property. Spaces, capitals and punctuation in both don't matter.

`"Anki Card - Standard Mono.Book:PNA Resistência"`
:   Rems whose *Book* property, from that tag, is exactly *PNA Resistência*. As in Anki, a value must match exactly unless it has wildcards.

`ankicardstandardmono.book:pna*`
:   the same property, starting with *pna*.

`*.book:*carlton*`
:   a *Book* property of any tag, containing *carlton*. `_` matches one character.

`*.chapter:`
:   an empty *Chapter*. `*.chapter:_*` finds one that isn't empty.

`incremental.priority<20`
:   a number compared: `<`, `<=`, `>`, `>=`, `=`, `!=`.

`incremental.nextrepdate<=0`
:   a date compared in **days from today**: `<=0` is today or earlier, `=1` tomorrow, `>=-7` the last week onwards.

The plugin's own values have shortcuts:

| Shortcut | Is |
|---|---|
| `prop:priority<20` | a flashcard's [card priority](Priorities-for-Flashcards.md) |
| `prop:incpriority<=10` | an IncRem's priority |
| `prop:incdue<=0` | an IncRem's next repetition date (days from today): due now |

`is:incremental prop:incdue<=0 prop:incpriority<=10`
:   IncRems due now with a priority of 10 or better.

## Recent changes { #recent }

`added:1`
:   Rems created today. `added:7` covers the last 7 days.

`edited:1`
:   Rems whose text was written today. This counts any change to the text, including ones made by a plugin or a bulk command, as Anki's `edited:` does.

## Wildcards { #wildcards }

| Key | `*` | `_` |
|---|---|---|
| Words | not needed: a word matches from its start | — |
| `tag:` | any part of a tag name | — |
| `in:`, `parent:` | any part of a document's (or Rem's) name | — |
| `source:`, `refs:` | any part of the name | — |
| `owner.name:value` | any part of the value | one character |
| `*.name` | any owner | — |

## Matching special characters { #special }

- **Spaces:** put the whole term in quotes, `"tag:anki card"`, or only the part after the colon, `tag:"anki card"`.
- **`and`, `or`:** to search for the word itself, quote it: `"or"`.
- **`-`, `"`, `(`, `)`, `\`:** put a `\` before the character, as in `\-free`, or quote the term.
- **`:`:** a colon is a search key only before one of the keys on this page or an `owner.name`. Anything else stays text, so `3:30` and a pasted `Note: …` search as words.

## When something is wrong { #messages }

Find Rem shows one line under the box, then searches the words with RemNote's search:

| Message | Meaning |
|---|---|
| *This "(" is never closed*, *This quote is never closed*, *"or" needs a search term on each side* … | The query can't be read as written. |
| *No Rem is named exactly "…"* | Check the name, or use `*` for part of it. |
| *… matches 1,074 Rems; make the name more precise* | A `*` in `in:` matched too many Rems. |
| *"is:due" is about cards, which come in a later phase* | Card searches are not available yet. |
| *The helper is indexing this knowledge base* | Once, for about 20 seconds; try again then. |
| *The AI helper is running but not paired* | Paste the token ([pairing](Desktop-Helpers.md#search)). |
| *… need the AI helper on the desktop* | The query uses search keys and the helper isn't answering. |

## Not available { #not-available }

Coming in a later version: card searches such as `is:due`, `card:cloze`, `rated:7`, `prop:ivl` and `introduced:30`.

Not planned: regular expressions (`re:`), wildcards inside a word (`d*g`), and Anki's flags, presets and duplicates, which have no counterpart in RemNote.

## How it works { #how }

The helper reads two things, never writing to either:

- **RemNote's search index** for words, phrases and where a Rem sits (`in:`, `path:`). These searches take a few milliseconds.
- **Its own index** of the knowledge base, for everything else: tags, kinds, Sources, references, dates, slot and property values. It is kept in `~/.incremental-remnote/search/` (about 180 MB for 440,000 Rems, readable only by you), built once in about 20 seconds, and brought up to date before each search from what RemNote wrote since the last one.

A Rem created a moment ago can be missing until RemNote has written it to its database, and its words until RemNote has indexed them; RemNote's own search has the same delay.

The plugin also uses the helper's index to find which Rems have a PDF or web page as their Source, for the PDF reader and the parent picker, instead of checking every IncRem in turn.
