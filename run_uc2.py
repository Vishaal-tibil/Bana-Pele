"""UC2 -- Inchara. Run: python3 run_uc2.py
Only this file and domains/coaching.py are yours to edit."""
import asyncio
from domains import coaching
from run_scenario import run_scenario

if __name__ == "__main__":
    asyncio.run(run_scenario(coaching.DOMAIN, coaching.build_providers(),
                              coaching.SAMPLE_INTENT, bap_id="my-journey-bap"))
