"""
UC2 domain data -- Naledi Discovers the Right Thabo.
Mock data for demo purposes. Replace with real coach catalog data when available --
this file is the only thing that should change; shared/network.py stays untouched.
"""
from shared.models import Provider, Item, Intent

def build_providers() -> list[Provider]:
    return [
        Provider(id="thabo_ndlovu", name="Thabo Ndlovu", participation_type="full_transaction",
                  items=[
                      Item(id="business_coaching", name="Business Registration Coaching",
                           attributes={"language": "Sesotho", "region": "Bushbuckridge",
                                       "availability": "weekdays", "rating_basis": "12 completed engagements"}),
                  ]),
        Provider(id="thandiwe_mkhize", name="Thandiwe Mkhize", participation_type="full_transaction",
                  items=[
                      Item(id="business_coaching", name="Business Registration Coaching",
                           attributes={"language": "isiZulu", "region": "Bushbuckridge",
                                       "availability": "weekends", "rating_basis": "8 completed engagements"}),
                  ]),
        Provider(id="sipho_dlamini", name="Sipho Dlamini", participation_type="full_transaction",
                  items=[
                      Item(id="financial_literacy", name="Financial Literacy Coaching",
                           attributes={"language": "Sesotho", "region": "Mpumalanga (province-wide)",
                                       "availability": "evenings", "rating_basis": "20 completed engagements"}),
                  ]),
        Provider(id="palesa_mokoena", name="Palesa Mokoena", participation_type="full_transaction",
                  items=[
                      Item(id="curriculum_support", name="Play-Based Curriculum Support",
                           attributes={"language": "Sesotho", "region": "Bushbuckridge",
                                       "availability": "weekdays", "rating_basis": "5 completed engagements"}),
                  ]),
        Provider(id="thabo_khumalo", name="Thabo Khumalo", participation_type="discovery_only",
                  items=[
                      Item(id="peer_mentoring", name="Peer Mentoring Circle",
                           attributes={"note": "runs via WhatsApp group -- not yet on network, contact to join"}),
                  ]),
    ]

DOMAIN = "coaching"
SAMPLE_INTENT = Intent(category="business_coaching", attributes={"language": "Sesotho", "region": "Bushbuckridge"})
