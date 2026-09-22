"""
UC1 domain data -- Vishaal plugs in real NGO catalog data here.
Same shared/network.py underneath -- only this file changes per use case.
"""
from shared.models import Provider, Item, Intent

def build_providers() -> list[Provider]:
    return [
        Provider(id="smartstart", name="SmartStart", participation_type="full_transaction",
                  items=[Item(id="starter_kit", name="ECD Starter Kit",
                               attributes={"region": "Bushbuckridge", "capacity": 5})]),
        Provider(id="grow", name="GROW", participation_type="full_transaction",
                  items=[Item(id="nutrition_pack", name="Nutrition Support Pack",
                               attributes={"region": "Bushbuckridge", "capacity": 8})]),
        Provider(id="impande", name="Impande", participation_type="discovery_only",
                  items=[Item(id="facility_grant", name="Facility Improvement Grant",
                               attributes={"region": "Bushbuckridge", "note": "apply via impande.org.za"})]),
    ]

DOMAIN = "ngo-support"
SAMPLE_INTENT = Intent(category="starter_kit", attributes={"region": "Bushbuckridge"})
