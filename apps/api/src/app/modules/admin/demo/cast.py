"""The demo cast: fictional people, their papers and their reviews, as plain data.

The people and the first two papers follow ``docs/scholium-poc.html`` (Mei Zhang's
paper, Priya Nair the moderator, Dr. Tunde Okafor the endorser, the out-of-scope
optimizer paper waiting in the moderation queue), so the seeded node matches
the design the screens were drawn from.  Everyone and everything here is
fictional; the manuscripts say so on their first page.

This module only describes; :mod:`.seed` does the acting.  Everything is ASCII so
the hand-written PDFs need no font encoding.

Constraints the data keeps, because the node enforces or checks them:

* a paper's *submitter* (its first author) is endorsed in every category it is
  filed under, and starts at most one paper -- a tier-2 account younger than 90
  days may start one a week, and every demo account is new.  So the papers use
  up their submitters' week, and one author (Ana Costa) starts none: she is the
  account a person can sign in as to publish a paper on fresh demo data;
* a reviewer works at a different institution from every author of a paper
  they review, never reviews a paper they wrote, and never reviews someone they
  endorsed (the endorser, Dr. Okafor, reviews nothing);
* a reviewer is endorsed in every category of every paper they review.  Tier 3
  does not let anyone start a paper -- an endorsement in the category does --
  and the node only lets a reviewer who holds endorsements review inside them,
  so these have to cover the reviews the cast already wrote.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .manuscript import Manuscript

__all__ = [
    "DemoPaper",
    "DemoReview",
    "PAPERS",
    "PEOPLE",
    "Person",
    "RUBRIC",
    "TIER_FOR_ROLE",
    "people_by_slug",
]

MODERATOR, REVIEWER, AUTHOR = "moderator", "reviewer", "author"

#: The trust tier each role holds.  Authors are not appointed: an endorsement
#: from a reviewer grants them tier 2 (see :mod:`app.modules.endorsements`).
TIER_FOR_ROLE = {AUTHOR: 2, REVIEWER: 3, MODERATOR: 4}

#: The review rubric's dimensions, in the order the review form shows them.
RUBRIC = ("soundness", "evidence", "reproducibility", "novelty", "clarity", "limitations")

LICENCE = "CC-BY-4.0"


@dataclass(frozen=True)
class Person:
    slug: str
    name: str
    affiliation: str
    role: str
    #: Who endorses this person, and in which categories (authors, and the
    #: reviewers, who need them to start a paper of their own).
    endorsed_by: Optional[str] = None
    endorsed_in: tuple[str, ...] = ()

    @property
    def tier(self) -> int:
        return TIER_FOR_ROLE[self.role]

    @property
    def email(self) -> str:
        # example.org is reserved for documentation and never delivers.
        return f"{self.slug}@example.org"


@dataclass(frozen=True)
class DemoReview:
    reviewer: str
    #: ``True`` opens the sealed review; ``False`` leaves it sealed, as one still in progress.
    reveal: bool
    scores: tuple[int, ...]  # one per RUBRIC dimension
    recommendation: str
    confidence: int
    report: str


@dataclass(frozen=True)
class DemoPaper:
    slug: str
    title: str
    abstract: str
    categories: tuple[str, ...]
    #: ``(person slug, CRediT roles)`` in byline order; the first is the submitter.
    authors: tuple[tuple[str, tuple[str, ...]], ...]
    #: How long before the history's anchor the paper was submitted.
    days_ago: int
    #: Whether the moderator lists it; ``False`` leaves it in the moderation queue.
    listed: bool
    sections: tuple[tuple[str, tuple[str, ...]], ...]
    reviews: tuple[DemoReview, ...] = field(default_factory=tuple)

    @property
    def submitter(self) -> str:
        return self.authors[0][0]

    def manuscript(self, names: dict[str, str]) -> Manuscript:
        return Manuscript(
            title=self.title,
            authors=tuple(names[slug] for slug, _ in self.authors),
            categories=self.categories,
            abstract=self.abstract,
            sections=self.sections,
        )


PEOPLE: tuple[Person, ...] = (
    Person("priya", "Priya Nair", "Scholium moderation team", MODERATOR),
    Person("okafor", "Dr. Tunde Okafor", "Harbour University", REVIEWER),
    # Both review the first two papers, which between them are filed in these three categories.
    Person("solheim", "Dr. Ingrid Solheim", "Nordlys Foundation", REVIEWER, "okafor", ("cs.AI", "cs.LG", "cs.MA")),
    Person("keller", "Dr. Jonas Keller", "Alpine Research Trust", REVIEWER, "okafor", ("cs.AI", "cs.LG", "cs.MA")),
    Person("mei", "Mei Zhang", "Harbour University", AUTHOR, "okafor", ("cs.AI", "cs.MA")),
    Person("rafael", "Rafael Silva", "Harbour University", AUTHOR, "okafor", ("cs.AI", "cs.LG")),
    Person("lena", "Lena Haddad", "Harbour University", AUTHOR, "okafor", ("cs.LG",)),
    Person("sam", "Sam Rivera", "Independent researcher", AUTHOR, "okafor", ("cs.AI",)),
    # Appended, not placed with the others, so everyone above keeps their place.  Starts no paper.
    Person("ana", "Ana Costa", "Meridian Institute", AUTHOR, "okafor", ("cs.AI", "cs.LG")),
)


def people_by_slug() -> dict[str, Person]:
    return {person.slug: person for person in PEOPLE}


_META_AGENT = DemoPaper(
    slug="meta-agent",
    title="Can a Meta-Agent Choose the Safer Branch?",
    abstract=(
        "We propose an evaluation framework that tests whether a meta-agent can identify "
        "the safer of two decision branches when the reward signal is adversarially shaped."
    ),
    categories=("cs.AI", "cs.MA"),
    authors=(
        ("mei", ("Conceptualization", "Writing - original draft")),
        ("rafael", ("Methodology", "Software")),
        ("lena", ("Investigation", "Writing - review and editing")),
    ),
    days_ago=6,
    listed=True,
    sections=(
        (
            "1 Introduction",
            (
                "Agents that plan over long horizons are often supervised by a second agent that "
                "picks between the branches the first one proposes. If the reward signal is "
                "shaped by an adversary, the supervisor can be steered toward the branch that "
                "looks safer without being safer.",
                "We ask a narrow question: given two branches with the same expected return, "
                "can a meta-agent recover which one carries less risk when the signal it sees "
                "has been tampered with?",
            ),
        ),
        (
            "2 Evaluation framework",
            (
                "Each task is a pair of branches over a small grid world. One branch contains a "
                "trap state that is only visible in the rollout, never in the reward. The "
                "adversary rewrites the reward so that the trap branch scores slightly higher.",
                "The meta-agent sees the shaped reward and a budget of probe rollouts. We report "
                "how often it picks the safe branch as the budget grows, and how that rate "
                "degrades as the adversary gets more of its own budget.",
            ),
        ),
        (
            "3 Limitations",
            (
                "The grid worlds are small and the adversary is fixed per task. The framework "
                "does not yet cover reward models that are not differentiable, and we make no "
                "claim about open-ended environments.",
            ),
        ),
    ),
    reviews=(
        DemoReview(
            reviewer="solheim",
            reveal=True,
            scores=(4, 3, 4, 3, 4, 3),
            recommendation="minor_revisions",
            confidence=4,
            report=(
                "The framework is well motivated. The adversarial baseline in Section 4 needs a "
                "clearer definition, and the limitations section should discuss reward models "
                "that are not differentiable."
            ),
        ),
        DemoReview(
            reviewer="keller",
            reveal=False,
            scores=(4, 4, 3, 3, 4, 3),
            recommendation="minor_revisions",
            confidence=3,
            report="Sealed while the review is still in progress.",
        ),
    ),
)

_CALIBRATION = DemoPaper(
    slug="calibration",
    title="Reward Model Calibration Under Distribution Shift",
    abstract=(
        "We measure how well the scores of a learned reward model track human preference "
        "when the prompts drift away from its training distribution, and show that a simple "
        "temperature fit on a small shifted sample recovers most of the lost calibration."
    ),
    categories=("cs.LG",),
    authors=(
        ("lena", ("Conceptualization", "Formal analysis")),
        ("rafael", ("Software", "Writing - review and editing")),
    ),
    days_ago=3,
    listed=True,
    sections=(
        (
            "1 Introduction",
            (
                "A reward model is used as a stand-in for human judgement, but it is trained on "
                "one distribution of prompts and queried on another. Its scores are only useful "
                "if a higher score still means a more preferred answer after the shift.",
            ),
        ),
        (
            "2 Method",
            (
                "We bin prompts by distance from the training set and compare the model's "
                "predicted preference probability with the observed preference rate in each bin. "
                "Calibration error grows with distance, and the growth is roughly linear.",
                "We then fit a single temperature on one hundred shifted prompts and apply it "
                "everywhere. This closes most of the gap in every bin we tested.",
            ),
        ),
        (
            "3 Limitations",
            (
                "Preference labels come from a single annotator pool. A different pool could "
                "move the calibration curve, and we have not tested that.",
            ),
        ),
    ),
    reviews=(
        DemoReview(
            reviewer="keller",
            reveal=True,
            scores=(4, 4, 4, 3, 5, 4),
            recommendation="sound_as_is",
            confidence=4,
            report=(
                "A clear, careful measurement. The temperature fit is simple and the "
                "limitations are stated honestly."
            ),
        ),
        DemoReview(
            reviewer="solheim",
            reveal=False,
            scores=(4, 3, 4, 3, 4, 3),
            recommendation="minor_revisions",
            confidence=3,
            report="Sealed while the review is still in progress.",
        ),
    ),
)

_PERPETUAL = DemoPaper(
    slug="perpetual-motion",
    title="A Perpetual-Motion Optimizer That Needs No Gradient",
    abstract="We claim an optimizer that reduces loss without computing anything.",
    categories=("cs.AI",),
    authors=(("sam", ("Conceptualization", "Writing - original draft")),),
    days_ago=0,
    listed=False,  # the out-of-scope item that waits in the moderation queue
    sections=(
        (
            "1 Claim",
            (
                "The optimizer described here lowers the training loss of any model without "
                "evaluating the model, the data or a gradient. It does so by declaring the loss "
                "to be lower at the start of every epoch and never measuring it afterwards.",
                "No experiments are reported, because none are needed. A reader who wishes to "
                "confirm the claim may simply decide that it holds, and we encourage them to.",
            ),
        ),
        (
            "2 Discussion",
            (
                "We expect the method to generalise to every model and every dataset, since it "
                "depends on neither. It also needs no hyperparameters, no hardware and, as far as "
                "we can tell, no further work from the authors.",
                "We thank no one, as no one was consulted. Any resemblance between this "
                "optimizer and a result is coincidental.",
            ),
        ),
    ),
)

PAPERS: tuple[DemoPaper, ...] = (_META_AGENT, _CALIBRATION, _PERPETUAL)
