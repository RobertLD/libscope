"""Quick-start example for the libscope Python SDK.

Start the server first: ``libscope serve api`` (http://localhost:3378).
"""

from pylibscope import LibscopeClient

with LibscopeClient() as client:
    # Adding runs on the server as a background task; wait for it to get the new documents.
    task = client.add_url("https://docs.python.org/3/tutorial/", tags=["python"])
    done = client.wait_for_task(task.id)
    for doc in done.result["documents"]:
        print(f"Indexed: {doc['title']} ({doc['documentId']})")

    task = client.add_text(
        "Error Handling Guide",
        "Use try/except blocks to handle exceptions in Python...",
        tags=["tutorial", "errors"],
    )
    client.wait_for_task(task.id)

    # Search the knowledge base
    page = client.search("how to handle exceptions", limit=5)
    for hit in page.items:
        print(f"  {hit.title}: {hit.score:.2f}")

    # Counts, topics and index health
    overview = client.overview()
    print(f"Total documents: {overview.stats.total_documents}")

    # Ask a question (the server needs an LLM: see llm.provider)
    answer = client.ask("What is the recommended error handling pattern?")
    print(f"Answer: {answer.answer}")
