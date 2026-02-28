# Sample API Reference

## Authentication

To authenticate, include your API key in the `Authorization` header:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://api.example.com/v1/users
```

### OAuth 2.0

For OAuth flows, redirect users to:

```
https://auth.example.com/authorize?client_id=YOUR_CLIENT_ID&response_type=code
```

## Users API

### List Users

```http
GET /v1/users
```

Returns a paginated list of users.

### Create User

```http
POST /v1/users
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com"
}
```

## Error Handling

All errors return a JSON response with an `error` field:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "The request body is missing required fields"
  }
}
```
