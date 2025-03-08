# Conquer Cells

A modern web application built with a microservices architecture using Python (Poetry) for the backend and a web client, orchestrated with Docker.

## 🚀 Project Structure

```
conquer_cells/
├── client/         # Frontend application
├── server/         # Backend service (Python/Poetry)
├── nginx/          # Nginx reverse proxy configuration
└── docker-compose.yml
```

## 🛠️ Prerequisites

- Docker and Docker Compose
- Poetry (for local development)
- Python 3.x

## 🏗️ Setup and Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd conquer_cells
   ```

2. Build and start the containers:
   ```bash
   docker-compose up --build
   ```

The application will be available at:
- Main application: http://localhost:8080
- Backend API: http://localhost:5001
- Frontend (direct): http://localhost:5002

## 🔧 Development

### Backend Development (with Poetry)

1. Navigate to the server directory:
   ```bash
   cd server
   ```

2. Install dependencies:
   ```bash
   poetry install
   ```

3. Activate the virtual environment:
   ```bash
   poetry shell
   ```

4. Run the development server:
   ```bash
   poetry run python main.py
   ```

### Frontend Development

1. Navigate to the client directory:
   ```bash
   cd client
   ```

2. Follow the client-specific README for development instructions.

## 🐳 Docker Commands

- Start all services:
  ```bash
  docker-compose up
  ```

- Rebuild and start services:
  ```bash
  docker-compose up --build
  ```

- Stop all services:
  ```bash
  docker-compose down
  ```

- View logs:
  ```bash
  docker-compose logs -f
  ```

## 🔄 API Documentation

The API documentation is available at:
- Swagger UI: http://localhost:5001/docs
- ReDoc: http://localhost:5001/redoc

## 📝 Configuration

The application uses the following ports by default:
- 8080: Nginx reverse proxy
- 5001: Backend API
- 5002: Frontend development server

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 📞 Support

For support, please open an issue in the GitHub repository. 