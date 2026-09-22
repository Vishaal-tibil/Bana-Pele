"""Runs both UC1 and UC2 back to back -- for demoing the shared infra together.
Vishaal and Inchara: use run_uc1.py / run_uc2.py individually day-to-day instead."""
import asyncio
from domains import ngo_support, coaching
from run_scenario import run_scenario, rule

async def main():
    await run_scenario(ngo_support.DOMAIN, ngo_support.build_providers(), ngo_support.SAMPLE_INTENT, bap_id="my-journey-bap")
    await run_scenario(coaching.DOMAIN, coaching.build_providers(), coaching.SAMPLE_INTENT, bap_id="my-journey-bap")
    rule("BOTH SCENARIOS COMPLETE -- same shared/network.py, different domain data")

if __name__ == "__main__":
    asyncio.run(main())
