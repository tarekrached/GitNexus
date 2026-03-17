from pkg_core.clients.base import CoreClient


class DataConsumer:
    def __init__(self):
        self.client = CoreClient("default")

    def fetch(self, keys):
        return self.client.get_data(keys)
