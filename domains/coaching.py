"""
UC2 domain data -- Naledi Discovers the Right Thabo.

Every name and category below is drawn from a named source, not invented:

  - "Thabo" is the doc's own generic coach persona -- see
    A13-Digital-Backbone-Functional-v22Sep2026.pdf section 9.2's title,
    "Naledi Discovers the Right Thabo", and the coaching narrative
    throughout. The doc never names an individual coach with a surname,
    so this file doesn't invent one either -- "Thabo A" / "Thabo B" /
    "Thabo C" instantiates the same persona three times, the same
    disambiguation convention the sibling BanaPele_UC1_UC2_Prototype
    reference (db.py) independently uses for this exact same problem.
  - Every item's name and `description` attribute is quoted directly
    from the doc's section 8 "Value exchange domains" table (p.14) --
    "Coaching and mentoring", "Learning and capacity development" and
    "Workforce and specialist services". The doc gives no specifics
    about what any individual Thabo actually offers, so none are
    invented here.

Still mock/illustrative data for demo purposes -- shared/network.py
stays untouched; this is the only file that should change for UC2.
"""
from shared.models import Provider, Item, Intent

def build_providers() -> list[Provider]:
    return [
        Provider(id="thabo_a", name="Thabo A", participation_type="full_transaction",
                  items=[
                      Item(id="coaching_mentoring", name="Coaching and mentoring",
                           attributes={"language": "Sesotho", "region": "Bushbuckridge",
                                       "availability": "weekdays",
                                       "description": "Coach discovery, matching, engagement, "
                                                       "follow-up and contribution records."}),
                  ]),
        Provider(id="thabo_b", name="Thabo B", participation_type="full_transaction",
                  items=[
                      Item(id="capacity_development", name="Learning and capacity development",
                           attributes={"language": "isiZulu", "region": "Bushbuckridge",
                                       "availability": "weekends",
                                       "description": "Courses, coaching, assessments, evidence "
                                                       "and learning pathways."}),
                  ]),
        Provider(id="thabo_c", name="Thabo C", participation_type="discovery_only",
                  items=[
                      Item(id="workforce_specialist", name="Workforce and specialist services",
                           attributes={"region": "Mpumalanga (province-wide)",
                                       "description": "Practitioners, specialists, recruitment "
                                                       "support and referrals.",
                                       "note": "not yet on the network -- contact directly"}),
                  ]),
    ]

DOMAIN = "coaching"
SAMPLE_INTENT = Intent(category="coaching_mentoring", attributes={"region": "Bushbuckridge"})
