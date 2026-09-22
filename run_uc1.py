"""UC1 -- Vishaal. Run: python3 run_uc1.py
Only this file and domains/ngo_support.py are yours to edit."""
import asyncio
from domains import ngo_support
from run_scenario import run_scenario

if __name__ == "__main__":
    asyncio.run(run_scenario(ngo_support.DOMAIN, ngo_support.build_providers(),
                              ngo_support.SAMPLE_INTENT, bap_id="my-journey-bap"))
