"""
UC1 domain data -- Connected NGO Support Network.

Every name and category below is drawn from a named source, not invented,
and now also encodes the doc's two distinct participation pathways
(section 7 "Participation pathways" / Appendix B2 "Participation
topology"), not just discovery-only vs full-transaction:

  - "SmartStart" and "Grow" are named directly in
    A13-Digital-Backbone-Functional-v22Sep2026.pdf as **independent
    node** examples -- Figure 2's Ecosystem row (p.7), and section 3.5's
    Network participant row: "SmartStart and Grow are examples" of
    independent nodes on the Bana Pele ECD Network. Each runs its own
    real BPP process (see network_v2/serve.py).
  - "Imbe" is named in that same section 3.5 sentence, but for the
    *other* pathway: "SmartStart and Grow are examples; **IMBE may
    instead participate through the Platform**." That's why Imbe is
    returned from `build_mediated_providers()`, not `build_providers()`
    -- it's published and answered for by the My Journey Network Adapter
    (network_v2/journey_adapter.py), not by a dedicated process of its
    own, matching exactly what the doc says about it.
  - Every item's name and `description` attribute is quoted directly
    from the doc's own section 8 "Value exchange domains" table (p.14).
    The doc gives no specifics about what any of these three actually
    offer, so none are invented here -- each is given one of the doc's
    own named categories.

Still mock/illustrative data for demo purposes -- shared/network.py
stays untouched; this is the only file that should change for UC1.
"""
from shared.models import Provider, Item, Intent

def build_providers() -> list[Provider]:
    """Independent nodes -- each runs its own real BPP process."""
    return [
        Provider(id="smartstart", name="SmartStart", participation_type="full_transaction",
                  items=[
                      Item(id="ecd_materials", name="ECD materials and resources",
                           attributes={"region": "Bushbuckridge",
                                       "description": "Learning materials, equipment, food-support "
                                                       "resources and distribution."}),
                  ]),
        Provider(id="grow", name="Grow", participation_type="full_transaction",
                  items=[
                      Item(id="capacity_development", name="Learning and capacity development",
                           attributes={"region": "Bushbuckridge",
                                       "description": "Courses, coaching, assessments, evidence "
                                                       "and learning pathways."}),
                  ]),
    ]

def build_mediated_providers() -> list[Provider]:
    """Platform-mediated participants -- published and answered on their
    behalf by the My Journey Network Adapter, not by a process of their
    own. See the module docstring for exactly where the doc names Imbe
    for this pathway."""
    return [
        Provider(id="imbe", name="Imbe", participation_type="discovery_only",
                  items=[
                      Item(id="registration_compliance", name="Registration and compliance",
                           attributes={"region": "Bushbuckridge",
                                       "description": "Requirements, application support, "
                                                       "inspections and verified status.",
                                       "note": "published via My Journey -- contact directly to proceed"}),
                  ]),
    ]

DOMAIN = "ngo-support"
SAMPLE_INTENT = Intent(category="ecd_materials", attributes={"region": "Bushbuckridge"})
