import os

def test_workerdbg():
    print("WORKER=", os.environ.get("PYTEST_XDIST_WORKER"))
    print("DATABASE_URL=", os.environ.get("DATABASE_URL"))
    assert True
