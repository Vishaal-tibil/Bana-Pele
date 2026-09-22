"""
UC2 domain data -- Inchara plugs in real coach/Thabo catalog data here.
Same shared/network.py underneath -- only this file changes per use case.
"""
from shared.models import Provider, Item, Intent

def build_providers() -> list[Provider]:
    return [
        Provider(id="thabo_a", name="Thabo A", participation_type="full_transaction",
                  items=[Item(id="business_coaching", name="Business Registration Coaching",
                               attributes={"language": "Sesotho", "availability": "weekdays"})]),
        Provider(id="thabo_b", name="Thabo B", participation_type="full_transaction",
                  items=[Item(id="business_coaching", name="Business Registration Coaching",
                               attributes={"language": "isiZulu", "availability": "weekends"})]),
        Provider(id="thabo_c", name="Thabo C", participation_type="discovery_only",
                  items=[Item(id="peer_mentoring", name="Peer Mentoring Circle",
                               attributes={"note": "contact via WhatsApp group, not yet on network"})]),
    ]

DOMAIN = "coaching"
SAMPLE_INTENT = Intent(category="business_coaching", attributes={"language": "Sesotho"})
