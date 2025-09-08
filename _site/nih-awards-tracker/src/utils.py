from datetime import date, timedelta

def date_window(days:int=90):
    end = date.today()
    start = end - timedelta(days=days)
    return start.isoformat(), end.isoformat()
