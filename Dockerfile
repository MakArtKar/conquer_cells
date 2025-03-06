# Use an official Python runtime as a parent image
FROM python:3.9-slim

# Set environment variables to avoid writing pyc files and enable buffering
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
# Disable Eventlet’s greendns patching
ENV EVENTLET_NO_GREENDNS=1

# Install system dependencies and curl (for Poetry installation)
RUN apt-get update && apt-get install -y curl build-essential

# Install Poetry
RUN curl -sSL https://install.python-poetry.org | python3 -

# Add Poetry to PATH
ENV PATH="/root/.local/bin:$PATH"

# Set the working directory in the container
WORKDIR /app

# Copy only the pyproject.toml and poetry.lock first for caching dependency installs
COPY pyproject.toml poetry.lock* /app/

# Configure Poetry to not create a virtual environment and install dependencies without dev dependencies and without installing the root project
RUN poetry config virtualenvs.create false && poetry install --without dev --no-root

# Copy the rest of the project files into the container
COPY . /app/

# Expose the port the app runs on
EXPOSE 5001

# Define the command to run your app using Flask-SocketIO
CMD ["python", "app.py"]
