"""
UC1 domain data -- Connected NGO Support Network.
Mock data for demo purposes. Replace with real NGO catalog data when available --
this file is the only thing that should change; shared/network.py stays untouched.
"""
from shared.models import Provider, Item, Intent

def build_providers() -> list[Provider]:
    return [
        Provider(id="smartstart", name="SmartStart", participation_type="full_transaction",
                  items=[
                      Item(id="starter_kit", name="ECD Starter Kit",
                           attributes={"region": "Bushbuckridge", "capacity": 5,
                                       "eligibility": "registered ELP"}),
                      Item(id="toy_library", name="Toy Library Loan Box",
                           attributes={"region": "Bushbuckridge", "capacity": 12,
                                       "eligibility": "any practitioner"}),
                  ]),
        Provider(id="grow", name="GROW", participation_type="full_transaction",
                  items=[
                      Item(id="nutrition_pack", name="Nutrition Support Pack",
                           attributes={"region": "Bushbuckridge", "capacity": 8,
                                       "eligibility": "means-tested"}),
                  ]),
        Provider(id="playsa", name="PlaySA", participation_type="full_transaction",
                  items=[
                      Item(id="play_training", name="Play-Based Learning Workshop",
                           attributes={"region": "Mpumalanga (province-wide)", "capacity": 20,
                                       "duration": "2-day workshop"}),
                  ]),
        Provider(id="njm_foundation", name="NJM Foundation", participation_type="full_transaction",
                  items=[
                      Item(id="wash_kit", name="WASH Facility Upgrade Kit",
                           attributes={"region": "Bushbuckridge", "capacity": 3,
                                       "eligibility": "site inspection required"}),
                  ]),
        Provider(id="impande", name="Impande", participation_type="discovery_only",
                  items=[
                      Item(id="facility_grant", name="Facility Improvement Grant",
                           attributes={"region": "Bushbuckridge",
                                       "note": "apply directly via impande.org.za -- not yet on network"}),
                  ]),
        Provider(id="ilifa", name="Ilifa Labantwana", participation_type="discovery_only",
                  items=[
                      Item(id="advocacy_referral", name="Policy & Advocacy Referral",
                           attributes={"region": "national",
                                       "note": "referral only -- contact via provincial office"}),
                  ]),
    ]

DOMAIN = "ngo-support"
SAMPLE_INTENT = Intent(category="starter_kit", attributes={"region": "Bushbuckridge"})
