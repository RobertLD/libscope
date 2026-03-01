"""Quick-start example for the libscope Python SDK."""

from pylibscope import LibscopeClient

# Connect to a local libscope server (default: http://localhost:3378)
with LibscopeClient() as client:
    # Add a document from a URL
    doc = client.add_document("https://docs.python.org/3/tutorial/")
    print(f"Indexed: {doc.title} (id={doc.id})")

    # Add a document from raw text
    text_doc = client.add_text(
        "Error Handling Guide",
        "Use try/except blocks to handle exceptions in Python...",
        topic="python",
        tags=["tutorial", "errors"],
    )

    # Search the knowledge base
    results = client.search("how to use decorators")
    for hit in results.results:
        print(f"  {hit.title}: {hit.score:.2f}")

    # Manage tags
    client.add_tags(doc.id, ["python", "tutorial"])

    # List topics
    topics = client.list_topics()
    for t in topics:
        print(f"Topic: {t.name}")

    # Get analytics
    stats = client.get_analytics()
    print(f"Total documents: {stats.total_documents}")

    # Ask a question (RAG)
    answer = client.ask("What is the recommended error handling pattern?")
    print(f"Answer: {answer.answer}")
